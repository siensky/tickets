/**
 * JWT verification (Auth0 JWKS), queue-token signing/validation, and M2M
 * scope checks — used by every service that needs to know who's calling.
 *
 * Implemented in Fas 3 (docs/plan.md fasplan). Until then this package
 * exists only so the workspace layout and import paths are final from
 * day one (rules.md §10: "Inga nya mappar utanför den beslutade
 * strukturen" — the structure is decided now, the implementation follows).
 */
export const AUTH_PACKAGE_NAME = '@tickets/auth';
