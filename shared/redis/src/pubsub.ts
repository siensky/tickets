/**
 * Redis Pub/Sub mellan poddar (docs/plan.md "Realtid"): så att
 * booking-api/scheduler-worker kan nå en WS-klient vars anslutning ligger
 * på en ANNAN realtime-gateway-podd. Fire-and-forget — ingen garanti att
 * meddelandet når fram om ingen lyssnar just då (docs/plan.md "Varje
 * WS-meddelande motsvaras av tillstånd klienten kan läsa om vid
 * återanslutning").
 *
 * En prenumererad ioredis-anslutning kan inte köra vanliga kommandon
 * (det kastar), så prenumeration sker alltid på en EGEN, duplicerad
 * anslutning — aldrig på klientens huvudanslutning.
 */
import type { Redis } from 'ioredis';

export async function publishToChannel(
  redis: Redis,
  channel: string,
  payload: unknown,
): Promise<void> {
  await redis.publish(channel, JSON.stringify(payload));
}

export interface ChannelSubscription {
  unsubscribe(): Promise<void>;
}

export async function subscribeToChannel(
  redis: Redis,
  channel: string,
  onMessage: (payload: unknown) => void,
): Promise<ChannelSubscription> {
  const subscriber = redis.duplicate();
  subscriber.on('message', (receivedChannel: string, raw: string) => {
    if (receivedChannel !== channel) {
      return;
    }
    onMessage(JSON.parse(raw));
  });
  await subscriber.subscribe(channel);
  return {
    async unsubscribe() {
      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    },
  };
}
