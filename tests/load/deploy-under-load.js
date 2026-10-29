// docs/plan.md 7.3: bevis för deploy utan nertid (VG). Egen profil, INTE normal-sale:
// normal-sale gav 13,6 % http_req_failed redan utan deploy (överlast), så den kan
// aldrig visa 0 fel.
//
// 10 iterationer/s (långt under taket) i 5 min, mot lasttest-eventet direkt efter
// `reset-sale` och med `loadtest-mode on`. En manuell åtgärd under körningen
// (`kubectl rollout restart deployment/booking-api -n ticketing`, två gånger) är
// själva deployen, se docs/runbook.md "Bevis: deploy utan nertid".
//
// Ett 409 ("stolen redan tagen") är ett korrekt svar, inte ett fel, så att eventet
// säljer slut under körningen är okej. Allt annat utanför 2xx räknas som fel och
// `http_req_failed: rate==0` gör k6 rött vid ett enda. `dropped_iterations: count==0`
// förhindrar att k6 tyst hoppar över försök och ger ett falskt "0 fel".
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { runFullBookingAttempt } from './lib/booking-flow.js';
import { BASE_K6_OPTIONS, SUMMARY_TREND_STATS } from './lib/config.js';

const MAX_WAIT_SECONDS = 60;
// 1 stol per försök: 10/s × 300 s = 3 000 stolar < 5 000, så eventet säljer aldrig slut och
// skrivvägarna (reservation, checkout) belastas under HELA körningen, inklusive båda deployerna.
const SEATS_PER_ATTEMPT = 1;

const completedBookings = new Counter('completed_bookings');

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409));

export const options = {
  ...BASE_K6_OPTIONS,
  scenarios: {
    deploy_under_load: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 200,
      maxVUs: 800,
    },
  },
  thresholds: {
    http_req_failed: ['rate==0'],
    dropped_iterations: ['count==0'],
    // Fångar bland annat 409 på checkout (setResponseCallback gäller globalt) och false positive.
    checks: ['rate==1.00'],
    // Utan minst en genomförd bokning kan "0 fel" bero på att inget skrevs alls.
    completed_bookings: ['count>0'],
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
};

export default function () {
  if (runFullBookingAttempt(MAX_WAIT_SECONDS, SEATS_PER_ATTEMPT)) {
    completedBookings.add(1);
  }
}
