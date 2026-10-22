/**
 * Autentisering av kötoken (docs/plan.md "Väntrum"): signaturen ensam
 * räcker (stateless), men ett revokerat token (shared/redis) måste
 * fortfarande stoppas även om signaturen är giltig.
 *
 * Returnerar ett resultat, kastar inget domänfel — det gör anroparen
 * (controller-lagret), som vet om det är kö-join, kö-status eller en
 * skyddad reservation som frågar (docs/rules.md §1: domänlagret kastar
 * domänfel, men "domänlagret" här är specifikt detta, inte
 * @tickets/auth/@tickets/redis som är oberoende delade paket).
 */
import { isQueueTokenRevoked, type RedisClient } from '@tickets/redis';
import { createQueueTokenSecret, verifyQueueToken } from '@tickets/auth';
import type { Logger } from '@tickets/observability';

export interface QueueAuthDeps {
  readonly redis: RedisClient;
  readonly queueTokenSecret: ReturnType<typeof createQueueTokenSecret>;
  readonly logger: Logger;
}

export type QueueAuthResult =
  | { readonly kind: 'valid'; readonly queueTokenId: string; readonly eventId: string }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Revokeringskollen failar ÖPPET om Redis inte svarar (docs/plan.md
 * "Väntrum": tokenen "är signerad och stateless ... Redis används till
 * revokering ... inte som enda sanning. Annars blir Redis en enskild
 * felpunkt som kan döda hela försäljningen"). Signaturen är redan
 * verifierad ovan — en Redis-hicka ska inte kunna stoppa hela
 * försäljningen, bara tillfälligt tillåta ett token som (sällan)
 * faktiskt är revokerat.
 */
async function isRevokedFailOpen(deps: QueueAuthDeps, queueTokenId: string): Promise<boolean> {
  try {
    return await isQueueTokenRevoked(deps.redis, queueTokenId);
  } catch (error) {
    deps.logger.warn(
      { error, queueTokenId },
      'queue token revocation check unreachable, failing open',
    );
    return false;
  }
}

export async function authenticateQueueToken(
  deps: QueueAuthDeps,
  token: string,
): Promise<QueueAuthResult> {
  const verification = await verifyQueueToken(deps.queueTokenSecret, token);
  if (verification.kind === 'invalid') {
    return verification;
  }
  const revoked = await isRevokedFailOpen(deps, verification.queueTokenId);
  if (revoked) {
    return { kind: 'invalid', reason: 'queue token has been revoked' };
  }
  return verification;
}
