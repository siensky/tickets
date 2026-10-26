/**
 * Bygger rapportfilen för `normal-sale`/`spike-sale` (docs/plan.md
 * "Lasttest" / "Rapport och reset" — testkonfiguration, starttid,
 * antal förfrågningar, svarstider (p50/p95/p99), genomströmning,
 * felfrekvens, antal slutförda köp, och bevis på att sålda biljetter
 * ≤ 5 000 och att inget `ticket_number` förekommer i mer än en order).
 * Körs MANUELLT efter en k6-körning, aldrig i CI (samma princip som
 * reset-sale.ts).
 *
 * k6:s `--summary-export=<fil>` skriver percentilerna under den nyckel
 * `summaryTrendStats` i k6-scriptets `options` bad om (tests/load/lib/
 * config.js sätter `p(50)`/`p(95)`/`p(99)` explicit) — saknas en nyckel
 * skrivs `null` i rapporten hellre än att skriptet kraschar på en
 * k6-version med annorlunda fältnamn.
 *
 * `oversell_prevented_total` är en RÅ, kumulativ Prometheus-räknare
 * sedan poddstart — `sum(oversell_prevented_total)` hade alltså räknat
 * med allt som hänt FÖRE den här körningen också (och nollställts om
 * HPA skalat ner mellan körningarna). `increase(...[<runDurationSeconds>s])`
 * isolerar bara ÖKNINGEN under själva körningen (upptäckt i Fas 6-reviewn).
 */
import { closeShardPools, createShardPools, getPoolForEvent } from '@tickets/db';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import {
  queryCompletedPurchaseCount,
  querySaleProof,
  type SaleProof,
} from '../repositories/sale-report-repository.js';

interface SaleReport {
  readonly scenario: string;
  readonly eventId: string;
  readonly generatedAt: string;
  readonly runDurationSeconds: number;
  readonly k6: {
    readonly totalRequests: number | null;
    readonly requestsPerSecond: number | null;
    readonly requestsFailedRate: number | null;
    readonly latencyMsP50: number | null;
    readonly latencyMsP95: number | null;
    readonly latencyMsP99: number | null;
  };
  readonly oversellPreventedDuringRun: number | null;
  readonly completedPurchaseCount: number;
  readonly proof: SaleProof;
}

/** Narrows one level of an unknown JSON object without assuming the rest of its shape (docs/rules.md §2). */
function prop(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function at(value: unknown, index: number): unknown {
  return Array.isArray(value) ? value[index] : undefined;
}

/**
 * Plockar ut en percentil/räknare ur k6:s `--summary-export`-JSON utan
 * att anta en fast typ på hela filen — exakta nyckelnamn varierar
 * mellan k6-versioner, `null` hellre än en krasch om en nyckel saknas.
 */
function readK6Metric(summary: unknown, metric: string, value: string): number | null {
  const raw = prop(prop(prop(prop(summary, 'metrics'), metric), 'values'), value);
  return typeof raw === 'number' ? raw : null;
}

async function queryOversellPreventedDuringRun(
  prometheusUrl: string,
  runDurationSeconds: number,
): Promise<number | null> {
  try {
    const query = `sum(increase(oversell_prevented_total[${String(runDurationSeconds)}s]))`;
    const response = await fetch(
      `${prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`,
    );
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    const resultEntry = at(prop(prop(body, 'data'), 'result'), 0);
    const raw = at(prop(resultEntry, 'value'), 1);
    // Prometheus' instant-query result is `[unixSeconds, "<value>"]` — the
    // value itself is always a STRING, never a number, in Prometheus' own
    // wire format.
    return typeof raw === 'string' ? Number(raw) : null;
  } catch {
    return null;
  }
}

async function generateReport(
  pool: Pool,
  eventId: string,
  scenario: string,
  k6SummaryPath: string,
  runDurationSeconds: number,
  prometheusUrl: string,
): Promise<SaleReport> {
  const summary: unknown = JSON.parse(readFileSync(k6SummaryPath, 'utf-8'));
  const [proof, completedPurchaseCount, oversellPreventedDuringRun] = await Promise.all([
    querySaleProof(pool, eventId),
    queryCompletedPurchaseCount(pool, eventId),
    queryOversellPreventedDuringRun(prometheusUrl, runDurationSeconds),
  ]);

  return {
    scenario,
    eventId,
    generatedAt: new Date().toISOString(),
    runDurationSeconds,
    k6: {
      totalRequests: readK6Metric(summary, 'http_reqs', 'count'),
      requestsPerSecond: readK6Metric(summary, 'http_reqs', 'rate'),
      requestsFailedRate: readK6Metric(summary, 'http_req_failed', 'rate'),
      latencyMsP50: readK6Metric(summary, 'http_req_duration', 'p(50)'),
      latencyMsP95: readK6Metric(summary, 'http_req_duration', 'p(95)'),
      latencyMsP99: readK6Metric(summary, 'http_req_duration', 'p(99)'),
    },
    oversellPreventedDuringRun,
    completedPurchaseCount,
    proof,
  };
}

async function main(): Promise<void> {
  const [eventId, scenario, k6SummaryPath, runDurationSecondsRaw, outPath] =
    process.argv.slice(2);
  if (
    eventId === undefined ||
    scenario === undefined ||
    k6SummaryPath === undefined ||
    runDurationSecondsRaw === undefined ||
    outPath === undefined
  ) {
    process.stderr.write(
      'Usage: node dist/scripts/generate-sale-report.js <eventId> <scenario> <k6-summary.json> <runDurationSeconds> <out.json>\n',
    );
    process.exitCode = 1;
    return;
  }
  const runDurationSeconds = Number(runDurationSecondsRaw);
  if (!Number.isFinite(runDurationSeconds) || runDurationSeconds <= 0) {
    process.stderr.write('runDurationSeconds must be a positive number\n');
    process.exitCode = 1;
    return;
  }
  const prometheusUrl =
    process.env['PROMETHEUS_URL'] ??
    'http://prometheus-operated.observability.svc.cluster.local:9090';
  const shardPools = createShardPools();
  try {
    const report = await generateReport(
      getPoolForEvent(shardPools, eventId),
      eventId,
      scenario,
      k6SummaryPath,
      runDurationSeconds,
      prometheusUrl,
    );
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    process.stdout.write(`Wrote report to ${outPath}\n`);
    if (!report.proof.soldWithinInventory || report.proof.duplicateTicketNumbers.length > 0) {
      process.stderr.write('WARNING: oversell proof failed — see report.proof\n');
      process.exitCode = 1;
    }
  } finally {
    await closeShardPools(shardPools);
  }
}

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
