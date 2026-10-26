/**
 * EN delad Redis-prenumeration per podd (`PSUBSCRIBE ws:*`) istället för
 * en ny duplicerad Redis-anslutning per WS-klient (Fas 6, Fas 3-reviewns
 * notering): vid 50 000 samtidiga klienter skulle den gamla
 * `subscribeToChannel`-per-anslutning sprängt Redis' default-gräns på
 * 10 000 anslutningar långt innan poddarna själva blev en begränsning.
 *
 * Varje podd startar EN registry vid uppstart (index.ts). Varje WS-
 * anslutning registrerar sig lokalt (synkront, inget Redis-anrop) mot
 * den kötoken-id den redan autentiserats mot; dispatchen till rätt
 * socket sker helt i minnet.
 */
import {
  subscribeToChannelPrefix,
  queueTokenIdFromWsChannel,
  wsChannelPattern,
  type RedisClient,
} from '@tickets/redis';

export type WsMessageHandler = (payload: unknown) => void;

export interface WsSubscriberRegistry {
  /** Registrerar en lokal mottagare för en kötoken-id. Returnerar en synkron unregister-funktion. */
  register(queueTokenId: string, onMessage: WsMessageHandler): () => void;
  close(): Promise<void>;
}

export async function startWsSubscriberRegistry(
  redis: RedisClient,
): Promise<WsSubscriberRegistry> {
  const handlersByQueueTokenId = new Map<string, Set<WsMessageHandler>>();

  const subscription = await subscribeToChannelPrefix(
    redis,
    wsChannelPattern(),
    (channel, payload) => {
      const handlers = handlersByQueueTokenId.get(queueTokenIdFromWsChannel(channel));
      if (handlers === undefined) {
        return;
      }
      // Per-handler try/catch: en socket som kastar (t.ex. redan i ett
      // stängt tillstånd) ska inte hindra ANDRA handlers för samma
      // kötoken-id (flera flikar/enheter) från att få samma meddelande.
      for (const handler of handlers) {
        try {
          handler(payload);
        } catch {
          // Medvetet tyst — fire-and-forget, se shared/redis/src/pubsub.ts.
        }
      }
    },
  );

  return {
    register(queueTokenId, onMessage) {
      let handlers = handlersByQueueTokenId.get(queueTokenId);
      if (handlers === undefined) {
        handlers = new Set();
        handlersByQueueTokenId.set(queueTokenId, handlers);
      }
      handlers.add(onMessage);
      return () => {
        const current = handlersByQueueTokenId.get(queueTokenId);
        current?.delete(onMessage);
        if (current?.size === 0) {
          handlersByQueueTokenId.delete(queueTokenId);
        }
      };
    },
    async close() {
      await subscription.unsubscribe();
    },
  };
}
