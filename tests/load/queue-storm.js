// docs/plan.md "Lasttest": `queue-storm` — 50 000 VU ansluter inom 60 s;
// mäter VÄNTRUMMET via EN RIKTIG WebSocket per VU (realtime-gatewayens
// Fas 6-ombyggnad: en delad `psubscribe`-anslutning per podd + HPA),
// inte REST-polling — en tidigare version av det här scriptet pollade
// i stället, vilket aldrig övade WS-sidan alls (Fas 6-reviewn).
//
// Siffrorna nedan är för EN generator-VM. Hela 50 000-skalan kräver
// 2-3 maskiner (docs/plan.md "Lasttest": "k6:s per-VU-modell för
// WebSockets är minnestung vid 50 000 VU") — kör SAMMA script på varje
// maskin med `--execution-segment`, se tests/load/README.md.
import { joinQueue, waitForAdmissionViaWebSocket } from './lib/booking-flow.js';
import { BASE_K6_OPTIONS, SUMMARY_TREND_STATS } from './lib/config.js';

const TOTAL_VUS = 50000;
// Kort ramp (10 s) till en platå, sedan håll platån resten av 60-
// sekundersfönstret — ger en integral (arean under rampen) nära
// TOTAL_VUS. En ren linjär 0→peak-ramp över hela 60 s hade bara gett
// HÄLFTEN av målet (arean under en triangel, inte en rektangel) —
// precis den bugg Fas 6-reviewn hittade i en tidigare version.
const RAMP_SECONDS = 10;
const HOLD_SECONDS = 50;
const PEAK_RATE_PER_SECOND = Math.round(TOTAL_VUS / (HOLD_SECONDS + RAMP_SECONDS / 2));

export const options = {
  ...BASE_K6_OPTIONS,
  scenarios: {
    queue_storm: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      // Per generator-VM (se filhuvudet) — dimensionerat för att en VU
      // kan hålla sin WS-anslutning öppen i upp till 15 min (sessionens
      // hårda tak) medan den väntar på insläpp.
      preAllocatedVUs: 3000,
      maxVUs: 20000,
      stages: [
        { target: PEAK_RATE_PER_SECOND, duration: `${RAMP_SECONDS}s` },
        { target: PEAK_RATE_PER_SECOND, duration: `${HOLD_SECONDS}s` },
        // Stoppa NYA anslutningar — redan anslutna VU:er fortsätter
        // vänta på egen hand (se default-funktionen), det är DÄR den
        // djupa kö-backloggen efter stormen faktiskt observeras.
        { target: 0, duration: '5s' },
      ],
    },
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
};

export default function () {
  const token = joinQueue();
  if (token === undefined) {
    return;
  }
  // 15 min = queue_session_total_minutes default (shared/db/migrations/
  // global/1700000004000_add-waiting-room-config.ts) — att INTE bli
  // insläppt inom fönstret är ett giltigt, förväntat utfall för de
  // flesta av de 50 000 (bara 5 000 biljetter finns), inte ett testfel.
  waitForAdmissionViaWebSocket(token, 15 * 60);
}
