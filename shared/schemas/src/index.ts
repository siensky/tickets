/**
 * Zod request/response schemas shared between backend validation and
 * frontend types/forms — "ett schema, tre användningar" (docs/forsvar.md
 * "Varför Zod när Fastify redan har JSON Schema-validering?"). Fastify's
 * own JSON-Schema validator stays the actual validation engine; Zod is
 * how the schema is authored once and reused.
 *
 * Implemented incrementally from Fas 2 onward as each endpoint is built.
 */
export const SCHEMAS_PACKAGE_NAME = '@tickets/schemas';
