// Delad config för alla k6-scenarier (docs/plan.md "Lasttest").
// Allt läses från miljövariabler (`k6 run -e KEY=value ...`), aldrig
// hårdkodat — samma event/host ska kunna bytas utan att röra scripten.

// `loadtest.<domän>` (icke-proxat, infra/terraform/dns.tf) för
// huvudkörningen; byt till `https://api.<domän>` för det mindre,
// CF-proxade testet (docs/plan.md "Ett mindre CF-proxat test körs också").
export const BASE_URL = __ENV.BASE_URL || 'https://loadtest.tikknet.se';

export const WS_BASE_URL = BASE_URL.replace(/^http/, 'ws');

// `ingress-loadtest.yaml` använder SAMMA letsencrypt-staging-issuer som
// resten av klustret innan "Byt till produktionscertifikat" körts
// (docs/runbook.md) — ett stagingcert litar k6 (precis som en
// webbläsare) inte på som default, vilket annars ger x509-fel på VARJE
// request (upptäckt i Fas 6-reviewn). Byt till `false` den dagen
// loadtest-hostnamnet också kör produktionsissuern.
export const BASE_K6_OPTIONS = {
  insecureSkipTLSVerify: true,
};

// Måste redan finnas (CSV-importerat) innan en körning — se
// docs/runbook.md.
export const EVENT_ID = __ENV.EVENT_ID;

// Kommaseparerad lista av FÖRUTFÄRDADE Auth0-access-tokens (docs/plan.md
// "Auth": "Lasttest använder förutfärdade tokens") — checkout krävs
// bakom en riktig inloggning, men identiteten som betalar är inte det
// som testas här. En liten pool återanvänds över alla VU:er. Se
// docs/runbook.md "Lasttest: förutfärdade Auth0-tokens" för hur poolen
// skapas.
export const AUTH_TOKENS = (__ENV.AUTH_TOKENS || '')
  .split(',')
  .filter((token) => token.length > 0);

export function randomAuthToken() {
  if (AUTH_TOKENS.length === 0) {
    throw new Error(
      'AUTH_TOKENS saknas — se docs/runbook.md "Lasttest: förutfärdade Auth0-tokens"',
    );
  }
  return AUTH_TOKENS[Math.floor(Math.random() * AUTH_TOKENS.length)];
}

// p50/p95/p99 krävs i rapporten (docs/plan.md "Rapport och reset") —
// k6:s default (`p(90)`) saknar dem, så varje scenario som ska
// rapporteras sätter `options.summaryTrendStats` till den här listan.
export const SUMMARY_TREND_STATS = ['avg', 'min', 'med', 'p(50)', 'p(95)', 'p(99)', 'max'];
