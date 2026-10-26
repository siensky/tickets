// docs/plan.md "Lasttest": `deploy-under-load` — SAMMA profil som
// normal-sale, körd MEDAN en ny booking-api-version rullas ut. Ingen
// egen trafikmodell att bygga: skillnaden är en MANUELL åtgärd under
// körningen (`kubectl rollout restart deployment/booking-api -n
// ticketing`, eller en riktig merge genom pipelinen), inte scriptet.
// Mätpunkten är "noll misslyckade requests" (docs/plan.md VG-krav) under
// precis den här körningen — jämför felfrekvensen mot en vanlig
// normal-sale-körning utan deploy.
export { options, default } from './normal-sale.js';
