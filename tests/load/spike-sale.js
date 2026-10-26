// docs/plan.md "Lasttest": `spike-sale` — BETYGSGRUNDANDE. ~50 000
// bokningsförsök över 6 minuter, MEDVETET ojämn: perioder med få VU och
// korta, tydliga toppar — motsatsen till normal-sale:s jämna takt.
//
// Stage-integralerna (arean under varje linjära ramp/platå) summerar nu
// till ≈50 100 — en tidigare version av dessa tal gav faktiskt ≈74 000,
// cirka 50 % över målet (Fas 6-reviewn räknade igenom det). Formen
// (lugnt/topp/lugnt/topp/lugnt/topp) är ändå poängen, inte sista
// siffran — justera `stages` om en exakt totalsumma behöver bevisas.
//
// Se normal-sale.js för varför insläppstakten (`queue_admission_rate_per_minute`)
// bör höjas live innan körningen — gäller här också, men ännu mer
// eftersom topparna medvetet ska pressa insläppet.
import { runFullBookingAttempt } from './lib/booking-flow.js';
import { BASE_K6_OPTIONS, SUMMARY_TREND_STATS } from './lib/config.js';

const MAX_WAIT_SECONDS = 120;

export const options = {
  ...BASE_K6_OPTIONS,
  scenarios: {
    spike_sale: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      // Toppen (337/s) × MAX_WAIT_SECONDS ≈ 40 400 samtidigt blockerade
      // VU i värsta fall — per generator-VM (se tests/load/README.md
      // för flermaskinskörningen), inte de 5 000 en tidigare version
      // satte (Fas 6-reviewn).
      preAllocatedVUs: 5000,
      maxVUs: 45000,
      stages: [
        { target: 14, duration: '60s' }, // lugnt inflöde
        { target: 337, duration: '30s' }, // topp 1
        { target: 7, duration: '120s' }, // lugnt igen, utdraget
        { target: 337, duration: '30s' }, // topp 2
        { target: 7, duration: '90s' }, // lugnt
        { target: 202, duration: '30s' }, // topp 3, mindre
      ],
    },
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
};

export default function () {
  runFullBookingAttempt(MAX_WAIT_SECONDS, 5);
}
