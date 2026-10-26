// docs/plan.md "Lasttest": `shard-failure` — SAMMA profil som
// normal-sale, körd medan shard-1 dödas (`kubectl delete pod` på
// poddnivå, docs/plan.md "Demomanus" — ALDRIG en hel nod, se den
// kommentaren för varför). Ingen egen trafikmodell: skillnaden är den
// manuella åtgärden under körningen, inte scriptet. Mätpunkten är att
// evenemang på shard-0 fortsätter fungera (events-service.ts:s
// `Promise.allSettled`-scatter-gather) medan shard-1 är nere.
export { options, default } from './normal-sale.js';
