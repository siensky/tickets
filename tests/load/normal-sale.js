// docs/plan.md "Lasttest": `normal-sale` — BETYGSGRUNDANDE. 50 000
// bokningsförsök (väntrum → karta → reservation → betalning) utspridda
// JÄMNT över 15 minuter. `constant-arrival-rate` är den enda executorn
// som faktiskt pacar iterationerna så — `shared-iterations` hade bara
// kört alla 50 000 så fort k6 orkade, vilket INTE är "jämnt spritt".
//
// 50 000 / 15 min ≈ 55,6/s — rate avrundas till 56/s, vilket ger ≈50 400
// totala försök över hela fönstret, inte EXAKT 50 000. Medveten
// avrundning, inte ett fel: en paced rate-test handlar om TAKTEN, inte
// om ett exakt sista-siffran-antal (samma anda som NOWAIT-409:orna i
// reservationstransaktionen — docs/plan.md "Concurrency-kärnan").
//
// VIKTIGT — höj insläppstakten innan du kör detta: default
// `queue_admission_rate_per_minute` (300/min = 5/s) är satt för att
// matcha de 5 000 biljetterna över en SESSION (15 min), inte för att
// hålla jämna steg med en 56/s ANKOMSTtakt i 15 minuter. Utan åtgärd
// växer kön obegränsat och nästan alla 50 000 VU:er blockerar hela
// `maxWaitSeconds` nedan i onödan (Fas 6-reviewn). Höj den live
// (docs/plan.md "Väntrum": "ändringsbara live") strax före körningen:
//
//   UPDATE config SET value = '3600' WHERE key = 'queue_admission_rate_per_minute';
//
// (3600/min = 60/s, en hårsmån över 56/s så kön inte växer). Sätt
// tillbaka till 300 efteråt.
import { runFullBookingAttempt } from './lib/booking-flow.js';
import { BASE_K6_OPTIONS, SUMMARY_TREND_STATS } from './lib/config.js';

// 56/s × 120 s (maxWaitSeconds nedan) = 6 720 samtidigt blockerade VU i
// värsta fall (ingen hinner bli insläppt inom taket alls) — maxVUs med
// marginal över det, inte de 3 000 en tidigare version råkade sätta
// (vilket hade gett massvis `dropped_iterations` redan vid normal takt,
// Fas 6-reviewn).
const MAX_WAIT_SECONDS = 120;

export const options = {
  ...BASE_K6_OPTIONS,
  scenarios: {
    normal_sale: {
      executor: 'constant-arrival-rate',
      rate: 56,
      timeUnit: '1s',
      duration: '15m',
      preAllocatedVUs: 1000,
      maxVUs: 8000,
    },
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
};

export default function () {
  runFullBookingAttempt(MAX_WAIT_SECONDS, 5);
}
