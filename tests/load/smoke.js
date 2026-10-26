// docs/plan.md "Lasttest": `smoke` — 10 VU, verifierar att hela flödet
// (väntrum → karta → reservation → betalning) fungerar innan en riktig
// körning startas. Körs FÖRST, alltid — ett misslyckat smoke-test
// betyder att normal-sale/spike-sale bara hade mätt samma trasiga flöde
// i större skala.
import { check } from 'k6';
import { runFullBookingAttempt } from './lib/booking-flow.js';
import { BASE_K6_OPTIONS } from './lib/config.js';

export const options = {
  ...BASE_K6_OPTIONS,
  scenarios: {
    smoke: {
      executor: 'shared-iterations',
      vus: 10,
      iterations: 10,
      maxDuration: '2m',
    },
  },
  thresholds: {
    checks: ['rate==1.00'], // smoke-testet ska vara 100 % grönt, inget "oftast"
  },
};

export default function () {
  check(null, { 'hela bokningsflödet lyckades': () => runFullBookingAttempt(60, 5) });
}
