/**
 * Zod request/response schemas shared between backend validation and
 * frontend types/forms — "ett schema, tre användningar" (docs/forsvar.md
 * "Varför Zod när Fastify redan har JSON Schema-validering?").
 *
 * Validerade i controller-lagret med `.safeParse()`, inte via Fastifys
 * `schema`-option — det hade krävt en Zod→JSON-Schema-konverterare
 * (t.ex. `@fastify/type-provider-zod`), ett nytt beroende som inte är
 * godkänt än. Samma Zod-scheman är ändå "ett schema, tre användningar":
 * delas med frontend-formulären och ger TypeScript-typerna.
 *
 * Implementerat successivt från Fas 2, utbyggt i Fas 3 med
 * väntrum/reservation-scheman i samband med de första riktiga HTTP-
 * endpointsen.
 */
export const SCHEMAS_PACKAGE_NAME = '@tickets/schemas';
export * from './event-id-param.js';
export * from './reservation.js';
