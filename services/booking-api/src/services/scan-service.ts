/**
 * Biljettskanning (docs/plan.md 7.13 E7). QR-koden är en HMAC som inte går att avkoda, så
 * biljetten slås upp på `tickets.qr_token` inom det valda eventets shard: ett fel event går
 * därför inte att skilja från en ogiltig kod, båda ger `not_found`. Allt avgörande sker i EN
 * transaktion; det unika indexet i `ticket_scans` gör att två samtidiga skanningar av samma
 * biljett ger exakt en `ok`. Sektionsnamnet hämtas från global-poolen efter transaktionen.
 */
import type { ServerAnalytics } from '@tickets/analytics/server';
import { getGlobalPool, getPoolForEvent, withTransaction, type ShardPools } from '@tickets/db';
import { InternalError } from '@tickets/domain';
import { toAlreadyScannedOutcome, toOkOutcome } from '../mappers/scan-mapper.js';
import {
  findTicketByQrToken,
  getExistingScan,
  insertScan,
} from '../repositories/scans-repository.js';
import { getSectionNames } from '../repositories/venues-repository.js';
import type { ScannableTicketRow, ScanOutcome } from '../types/scan.js';

export interface ScanServiceDeps {
  readonly shardPools: ShardPools;
  readonly analytics: ServerAnalytics;
}

export interface ScanParams {
  readonly eventId: string;
  readonly qrToken: string;
  readonly gate: string;
  readonly staffSub: string;
}

type TransactionResult =
  | { readonly kind: 'final'; readonly outcome: ScanOutcome }
  | { readonly kind: 'scanned'; readonly ticket: ScannableTicketRow };

async function recordScan(
  deps: ScanServiceDeps,
  params: ScanParams,
): Promise<TransactionResult> {
  return withTransaction(getPoolForEvent(deps.shardPools, params.eventId), async (client) => {
    const ticket = await findTicketByQrToken(client, params.eventId, params.qrToken);
    if (ticket === undefined) {
      return { kind: 'final', outcome: { result: 'not_found' } };
    }
    if (ticket.status !== 'valid') {
      return { kind: 'final', outcome: { result: ticket.status } };
    }
    const inserted = await insertScan(client, {
      eventId: params.eventId,
      ticketId: ticket.id,
      gate: params.gate,
      scannedBy: params.staffSub,
    });
    if (inserted) {
      return { kind: 'scanned', ticket };
    }
    const existing = await getExistingScan(client, params.eventId, ticket.id);
    if (existing === undefined) {
      throw new InternalError('ticket_scans row vanished after a conflicting insert', {
        ticketId: ticket.id,
      });
    }
    return { kind: 'final', outcome: toAlreadyScannedOutcome(existing) };
  });
}

async function describeScannedTicket(
  deps: ScanServiceDeps,
  ticket: ScannableTicketRow,
): Promise<ScanOutcome> {
  const sections = await getSectionNames(getGlobalPool(deps.shardPools), [ticket.sectionId]);
  // Biljetten är redan markerad som skannad: ett saknat sektionsnamn får inte göra gästen
  // till "redan skannad" vid ett nytt försök, så svaret faller tillbaka på rad och plats.
  return toOkOutcome(ticket, sections.get(ticket.sectionId)?.name ?? '');
}

export async function scanTicket(
  deps: ScanServiceDeps,
  params: ScanParams,
): Promise<ScanOutcome> {
  const transaction = await recordScan(deps, params);
  const outcome =
    transaction.kind === 'final'
      ? transaction.outcome
      : await describeScannedTicket(deps, transaction.ticket);
  deps.analytics.track(
    params.staffSub,
    'ticket_scanned',
    { result: outcome.result, gate: params.gate },
    { personless: true },
  );
  return outcome;
}
