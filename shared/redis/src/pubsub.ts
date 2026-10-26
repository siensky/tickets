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

/**
 * Som subscribeToChannel, men för ett MÖNSTER av kanaler på EN delad
 * duplicerad anslutning istället för en ny anslutning per kanal (Fas 6,
 * Fas 3-reviewns notering): realtime-gateway prenumererar en gång per
 * podd på `ws:*` och dispatchar varje träff lokalt — se
 * ws-subscriber-registry.ts. Vid 50 000 samtidiga WS-klienter hade en
 * `subscribeToChannel`-anslutning VAR sprängt Redis' default-gräns på
 * 10 000 anslutningar långt innan poddarna själva blev en begränsning.
 */
export async function subscribeToChannelPrefix(
  redis: Redis,
  pattern: string,
  onMessage: (channel: string, payload: unknown) => void,
): Promise<ChannelSubscription> {
  const subscriber = redis.duplicate();
  subscriber.on('pmessage', (_pattern: string, channel: string, raw: string) => {
    // Till skillnad från subscribeToChannel delar ALLA WS-klienter på
    // podden den här EN anslutningen (ws-subscriber-registry.ts) — ett
    // JSON.parse-fel på ett illa formaterat meddelande, eller en
    // handler som kastar, är annars en OFÅNGAD exception i ioredis'
    // egen event-emission, vilket kraschar HELA podden och fäller
    // samtliga dess WS-klienter, inte bara en (upptäckt i Fas 6-
    // reviewn). Fire-and-forget-leveransen tål redan att ett enskilt
    // meddelande tappas (filens egen header-kommentar) — det gör den
    // alltså även här.
    try {
      onMessage(channel, JSON.parse(raw));
    } catch {
      // Medvetet tyst — se kommentaren ovan.
    }
  });
  await subscriber.psubscribe(pattern);
  return {
    async unsubscribe() {
      await subscriber.punsubscribe(pattern);
      await subscriber.quit();
    },
  };
}
