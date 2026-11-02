/** Fasta val för scannern (docs/plan.md 7.8). */

/** Fast lista över grindar; scannern väljer en och skickar den med varje skanning. */
export const GATES = ['Grind A', 'Grind B', 'Grind C', 'Grind D'] as const;
export type Gate = (typeof GATES)[number];

/** Permissionen som krävs i access-tokenet (satt av Auth0 RBAC). */
export const SCAN_PERMISSION = 'scan:tickets';

/** Hur länge ett resultat visas i helskärm innan kameran är tillbaka. */
export const RESULT_DISPLAY_MS = 2500;

/** Samma kod skannas inte om inom så här lång tid. */
export const SCAN_DEBOUNCE_MS = 3000;
