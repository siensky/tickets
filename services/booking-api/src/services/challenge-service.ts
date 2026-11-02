/**
 * Adaptivt botskydd för `POST /events/:eventId/queue/join` (docs/plan.md 8.5). Nivån räknas ur signaler som
 * redan finns i Redis: 0 = ingen utmaning, 1 = proof of work (osynlig), 2 = Cloudflare Turnstile. Allt styrs av
 * `config` (kill switch + tröskelvärden) och en delad bypass-header åt lasttestet. Redis- eller config-fel
 * släpper igenom (fail-open, som rate limitern): botskyddet får aldrig stoppa en riktig försäljning.
 */
import { timingSafeEqual, createHash } from 'node:crypto';
import { getGlobalPool, type ShardPools } from '@tickets/db';
import { ChallengeRequiredError, isBaseError } from '@tickets/domain';
import type { Logger } from '@tickets/observability';
import {
  challengeAttemptsKey,
  challengeJoinsKey,
  challengePowFailKey,
  challengePowUsedKey,
  claimOnce,
  decrementCounter,
  getCachedConfigValue,
  getWaitingRoomDepth,
  incrementCounter,
  readCounter,
  waitingRoomKey,
  type RedisClient,
} from '@tickets/redis';
import {
  getChallengeConfig,
  parseChallengeConfig,
} from '../repositories/config-repository.js';
import type {
  ChallengeConfig,
  ChallengeProof,
  ChallengeRequirement,
} from '../types/challenge.js';
import { issuePowChallenge, powChallengeHash, verifyPow } from './pow.js';
import { verifyTurnstileToken, type FetchFn, type TurnstileConfig } from './turnstile.js';

const CONFIG_CACHE_SECONDS = 5;
const POW_TTL_SECONDS = 120;
const ATTEMPT_WINDOW_SECONDS = 60;
const JOIN_WINDOW_SECONDS = 600;
const POW_FAIL_WINDOW_SECONDS = 600;
const POW_FAILS_BEFORE_TURNSTILE = 3;
// Ankrat mot kända skriptklienter (början av strängen) och hela orden bot/crawler/spider, så att t.ex. mobilmärket
// "CUBOT" eller inbyggda appwebbläsare inte räknas som automater.
const SUSPICIOUS_UA =
  /^$|^(curl|wget|python|go-http-client|node-fetch|axios|okhttp|libwww|scrapy|java)\b|\b(bot|crawler|spider)\b/i;

export interface ChallengeDeps {
  readonly shardPools: ShardPools;
  readonly redis: RedisClient;
  readonly logger: Logger;
  readonly powKey: Buffer;
  /** `undefined` när `TURNSTILE_SECRET_KEY` saknas: nivå 2 nedgraderas då till nivå 1. */
  readonly turnstile: TurnstileConfig | undefined;
  /** `CHALLENGE_BYPASS_TOKEN`: undantag åt lasttestet, `undefined` = inget undantag finns. */
  readonly bypassToken: string | undefined;
  readonly fetchFn?: FetchFn;
  readonly now?: () => number;
}

export interface JoinRequestInfo {
  readonly eventId: string;
  readonly ip: string;
  readonly userAgent: string | undefined;
  readonly bypass: string | undefined;
  readonly proof: ChallengeProof;
}

type Level = 0 | 1 | 2;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function isBypass(deps: ChallengeDeps, presented: string | undefined): boolean {
  if (deps.bypassToken === undefined || deps.bypassToken === '' || presented === undefined) {
    return false;
  }
  return timingSafeEqual(digest(deps.bypassToken), digest(presented));
}

async function loadConfig(deps: ChallengeDeps): Promise<ChallengeConfig> {
  const raw = await getCachedConfigValue(
    deps.redis,
    'challenge_bundle',
    CONFIG_CACHE_SECONDS,
    async () => JSON.stringify(await getChallengeConfig(getGlobalPool(deps.shardPools))),
  );
  return parseChallengeConfig(raw);
}

/**
 * Antal olika signaler. Varje request räknas som ett försök (även med "bevis": en påhittad header ska inte kunna
 * stänga av signalen), och en join RESERVERAS här med INCR så att N parallella requests ser 1..N i stället för alla
 * 0. IP-volymen (försök eller joins) räknas som EN signal, så ett delat nät ensamt ger högst nivå 1.
 */
async function countSignals(
  deps: ChallengeDeps,
  config: ChallengeConfig,
  info: JoinRequestInfo,
): Promise<number> {
  const attempts = await incrementCounter(
    deps.redis,
    challengeAttemptsKey(info.ip),
    ATTEMPT_WINDOW_SECONDS,
  );
  const joins = await incrementCounter(
    deps.redis,
    challengeJoinsKey(info.eventId, info.ip),
    JOIN_WINDOW_SECONDS,
  );
  const depth =
    config.globalQueueDepth > 0
      ? await getWaitingRoomDepth(deps.redis, waitingRoomKey(info.eventId))
      : 0;
  const signals = [
    attempts > config.ipAttemptsPerMinute || joins > config.ipJoinsPerWindow,
    config.globalQueueDepth > 0 && depth > config.globalQueueDepth,
    info.userAgent === undefined || SUSPICIOUS_UA.test(info.userAgent),
  ];
  return signals.filter(Boolean).length;
}

async function decideLevel(
  deps: ChallengeDeps,
  signals: number,
  info: JoinRequestInfo,
): Promise<Level> {
  if (signals === 0) {
    return 0;
  }
  const powFails = await readCounter(deps.redis, challengePowFailKey(info.eventId, info.ip));
  const wantsTurnstile = signals >= 2 || powFails >= POW_FAILS_BEFORE_TURNSTILE;
  return wantsTurnstile && deps.turnstile !== undefined ? 2 : 1;
}

function powRequirement(
  deps: ChallengeDeps,
  config: ChallengeConfig,
  info: JoinRequestInfo,
): ChallengeRequirement {
  const issued = issuePowChallenge(
    deps.powKey,
    info.ip,
    info.eventId,
    config.powBits,
    (deps.now ?? Date.now)(),
    POW_TTL_SECONDS,
  );
  return { type: 'pow', ...issued };
}

async function checkPow(deps: ChallengeDeps, info: JoinRequestInfo): Promise<boolean> {
  const { powChallenge, powSolution } = info.proof;
  if (powChallenge === undefined || powSolution === undefined) {
    return false;
  }
  const verdict = verifyPow(
    deps.powKey,
    powChallenge,
    powSolution,
    info.ip,
    info.eventId,
    (deps.now ?? Date.now)(),
  );
  if (verdict === 'invalid') {
    // Bara ogiltiga lösningar räknas mot Turnstile-tröskeln, inte utgångna eller redan använda (en gammal flik).
    await incrementCounter(
      deps.redis,
      challengePowFailKey(info.eventId, info.ip),
      POW_FAIL_WINDOW_SECONDS,
    );
    return false;
  }
  // Engångsmarkeringen sätts först efter en giltig lösning, så ett felaktigt försök inte bränner utmaningen.
  return (
    verdict === 'ok' &&
    (await claimOnce(
      deps.redis,
      challengePowUsedKey(powChallengeHash(powChallenge)),
      POW_TTL_SECONDS,
    ))
  );
}

async function checkTurnstile(deps: ChallengeDeps, info: JoinRequestInfo): Promise<boolean> {
  const token = info.proof.turnstileToken;
  if (token === undefined || deps.turnstile === undefined) {
    return false;
  }
  return verifyTurnstileToken(deps.turnstile, token, info.ip, deps.fetchFn, (reason) => {
    deps.logger.warn({ reason }, 'turnstile verification failed');
  });
}

/** Kastar `ChallengeRequiredError` om beviset saknas eller inte håller för den nivå som beslutats. */
async function enforceLevel(
  deps: ChallengeDeps,
  config: ChallengeConfig,
  level: Level,
  info: JoinRequestInfo,
): Promise<void> {
  if (level === 2) {
    if (!(await checkTurnstile(deps, info))) {
      throw new ChallengeRequiredError({ type: 'turnstile' });
    }
    return;
  }
  // Nivå 1 verifierar aldrig Turnstile: ingen request utan lösning ska kunna tvinga fram ett externt anrop.
  if (level === 1 && !(await checkPow(deps, info))) {
    throw new ChallengeRequiredError(powRequirement(deps, config, info));
  }
}

/** Frigör join-reservationen (ett 428 eller en misslyckad join får aldrig räknas som en join). */
async function releaseJoin(
  deps: ChallengeDeps,
  info: Pick<JoinRequestInfo, 'eventId' | 'ip'>,
): Promise<void> {
  try {
    await decrementCounter(deps.redis, challengeJoinsKey(info.eventId, info.ip));
  } catch (error) {
    deps.logger.warn({ error }, 'could not release join reservation');
  }
}

async function enforce(deps: ChallengeDeps, info: JoinRequestInfo): Promise<boolean> {
  const config = await loadConfig(deps);
  if (!config.enabled) {
    return false;
  }
  const level = await decideLevel(deps, await countSignals(deps, config, info), info);
  try {
    await enforceLevel(deps, config, level, info);
  } catch (error) {
    await releaseJoin(deps, info);
    throw error;
  }
  return true;
}

export interface JoinReservation {
  /** Anropa om själva joinen misslyckas, så att reservationen inte räknas som en join. */
  readonly release: () => Promise<void>;
}

const NO_RESERVATION: JoinReservation = { release: () => Promise.resolve() };

/**
 * Kastar `ChallengeRequiredError` (428) om klienten måste lösa en utmaning före join. Annars returneras en
 * reservation som räknar joinen mot IP:ns join-signal (frigörs med `release` om joinen misslyckas).
 */
export async function enforceJoinChallenge(
  deps: ChallengeDeps,
  info: JoinRequestInfo,
): Promise<JoinReservation> {
  if (isBypass(deps, info.bypass)) {
    deps.logger.info({ ip: info.ip }, 'challenge bypassed (load test token)');
    return NO_RESERVATION;
  }
  try {
    const reserved = await enforce(deps, info);
    return reserved ? { release: () => releaseJoin(deps, info) } : NO_RESERVATION;
  } catch (error) {
    if (error instanceof ChallengeRequiredError) {
      throw error;
    }
    // Fail-open: ett fel i botskyddet (Redis, config) får aldrig stoppa en riktig försäljning. Ett fel som inte
    // är operationellt (t.ex. ogiltig config) loggas som error så att det syns i larm.
    if (isBaseError(error) && !error.isOperational) {
      deps.logger.error({ error }, 'challenge check failed, allowing join (fail-open)');
    } else {
      deps.logger.warn({ error }, 'challenge check failed, allowing join (fail-open)');
    }
    return NO_RESERVATION;
  }
}
