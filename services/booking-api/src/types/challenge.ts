/** Botskyddets typer (docs/plan.md 8.5). */
export interface ChallengeConfig {
  readonly enabled: boolean;
  /** Försök per IP och minut (utan lösning) över vilket IP:n räknas som misstänkt. */
  readonly ipAttemptsPerMinute: number;
  /** Lyckade join per IP och event under 10 minuter över vilket IP:n räknas som misstänkt. */
  readonly ipJoinsPerWindow: number;
  /** Ködjup över vilket alla utmanas; 0 = signalen avstängd. */
  readonly globalQueueDepth: number;
  readonly powBits: number;
}

/** Vad klienten ska göra för att få gå med: lösa en PoW (osynligt) eller ett Turnstile (synligt). */
export type ChallengeRequirement =
  | {
      readonly type: 'pow';
      readonly challenge: string;
      readonly bits: number;
      readonly expiresAt: number;
    }
  | { readonly type: 'turnstile' };

/** Bevis som klienten bifogar på ett nytt försök (headers `x-pow-*`, `x-turnstile-token`). */
export interface ChallengeProof {
  readonly powChallenge: string | undefined;
  readonly powSolution: string | undefined;
  readonly turnstileToken: string | undefined;
}
