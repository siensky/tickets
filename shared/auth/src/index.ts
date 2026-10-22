/**
 * JWT-verifiering (Auth0 JWKS) och signering/validering av kötoken
 * (docs/plan.md "Auth" / "Väntrum") — används av varje tjänst som
 * behöver veta vem som anropar. Implementerat i Fas 3.
 *
 * M2M-scope-kontroller (client credentials) är INTE med här — den
 * mekanismen hör uteslutande till scanner-appen (docs/plan.md "Auth":
 * "OAuth2 client credentials för scanner-appen"), och scanner-appen är
 * flyttad till efter inlämningen ("Flyttat till efter inlämningen:
 * scanner-appen"). Läggs till den dagen den fasen byggs.
 */
export * from './auth0-verifier.js';
export * from './queue-token.js';
