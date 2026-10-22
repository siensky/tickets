/**
 * Redis connection factory (docs/plan.md "Redis — användningsområden").
 * One command connection per process; code that needs to SUBSCRIBE must
 * open its own duplicated connection (ioredis forbids issuing normal
 * commands on a connection that's subscribed) — see pubsub.ts.
 */
import Redis from 'ioredis';

export type RedisClient = Redis;

export function createRedisClient(url: string): RedisClient {
  return new Redis(url, {
    maxRetriesPerRequest: 3,
  });
}

export async function closeRedisClient(client: RedisClient): Promise<void> {
  await client.quit();
}
