/**
 * Delad konsumentbas för RabbitMQ (docs/plan.md "Idempotens": "Delivery
 * limit på RabbitMQ-köerna (quorum-kö med `x-delivery-limit` ...)").
 *
 * `x-queue-type: quorum` + `x-delivery-limit` gör att mäklaren slutar
 * leverera ett meddelande som returneras (kanalen dör, konsumenten
 * kraschar) fler än `deliveryLimit` gånger. Men en `basic.nack` med
 * requeue=true räknas INTE av mäklaren i RabbitMQ 4 (verifierat: bara
 * headern `x-acquired-count` ökar, aldrig `x-delivery-count`), så ett
 * giftigt meddelande som nackas av handlern loopade för evigt. Därför
 * räknar konsumenten själv med `x-acquired-count`: på det `deliveryLimit`:e
 * misslyckade försöket nackas meddelandet med requeue=false, vilket
 * dead-letterar det (policyn nedan) i stället för att köa om det. Utan en
 * gräns blir det evig redelivery → växande ködjup → KEDA skalar till 10
 * kraschloopande poddar mitt i lastdemon (docs/plan.md "Idempotens").
 *
 * Dead-letter (docs/plan.md 8.6): ett meddelande som överskrider gränsen
 * hamnar i `<kö>.dead` via exchangen `tickets.dlx` i stället för att
 * försvinna. Koden deklarerar bara exchangen, dödkön och bindningen
 * (additivt, ändrar inga argument på befintliga köer). Själva kopplingen
 * kö → exchange görs av en POLICY (infra/k8s/base/rabbitmq/definitions.json),
 * eftersom en köes argument inte kan ändras efter att den skapats
 * (PRECONDITION_FAILED). Ingen adminvy: RabbitMQs egen managementvy visar
 * dödköerna, och Grafana larmar när en är icke-tom.
 *
 * Återansluter med exponentiell backoff om anslutningen tappas efter
 * att den väl upprättats — annars dör konsumenten TYST vid en
 * RabbitMQ-omstart medan podden fortfarande räknas som redo (det här
 * krockar med både kronjuveltest 4, docs/plan.md:431, och zero-downtime
 * i Fas 6). `connection`/`channel` är EventEmitters — utan en
 * `'error'`-lyssnare kastar Node ett ohanterat undantag och kraschar
 * processen på första glappet.
 */
import { connect, type ChannelModel, type Channel, type ConsumeMessage } from 'amqplib';

/** Exchangen som döda meddelanden skickas till (policyn pekar hit). Routing key = den ursprungliga kön. */
export const DEAD_LETTER_EXCHANGE = 'tickets.dlx';

export function deadLetterQueueName(queue: string): string {
  return `${queue}.dead`;
}

const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

export interface ConsumeOptions {
  readonly exchange: string;
  readonly queue: string;
  readonly routingKey: string;
  readonly deliveryLimit: number;
  readonly prefetch?: number;
  /**
   * Fler fel som ska räknas som tillfälliga (köas om, räknas inte mot `deliveryLimit`). Tjänsten skickar
   * in sina egna, t.ex. `isConnectionTimeout` från @tickets/db: en full databaspool under en försäljning
   * sa annars upp en betald betalningshändelse till dödkön efter fem försök.
   */
  readonly isTransient?: (error: unknown) => boolean;
}

export type MessageHandler = (
  payload: unknown,
  messageId: string | undefined,
) => Promise<void>;

export interface RabbitConsumer {
  close(): Promise<void>;
}

async function setUpQueue(channel: Channel, options: ConsumeOptions): Promise<void> {
  await channel.assertExchange(options.exchange, 'topic', { durable: true });
  await channel.assertQueue(options.queue, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': options.deliveryLimit,
    },
  });
  await channel.bindQueue(options.queue, options.exchange, options.routingKey);

  const deadQueue = deadLetterQueueName(options.queue);
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });
  await channel.assertQueue(deadQueue, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await channel.bindQueue(deadQueue, DEAD_LETTER_EXCHANGE, options.queue);
}

function parseMessage(message: ConsumeMessage): unknown {
  return JSON.parse(message.content.toString());
}

// amqplib:s egna typer ger `messageId` som `any` — @types/amqplib
// avmodellerar inte AMQP-fältet. Validerad här i stället för att låta
// `any` läcka in i handler-signaturen (docs/rules.md §2: inget `any`).
function readMessageId(message: ConsumeMessage): string | undefined {
  const value: unknown = message.properties.messageId;
  return typeof value === 'string' ? value : undefined;
}

/** Antal tidigare leveranser av meddelandet (RabbitMQ 4:s `x-acquired-count`); 0 vid första leveransen. */
function readAcquiredCount(message: ConsumeMessage): number {
  const value: unknown = message.properties.headers?.['x-acquired-count'];
  return typeof value === 'number' ? value : 0;
}

// Tillfälliga fel (en shard som inte nås) säger inget om meddelandet: de köas alltid om och räknas inte mot
// gränsen, så ett kort databasavbrott inte dödar betalningshändelser. Duck-typat på `code` (ShardUnavailableError i
// @tickets/domain) så att paketet slipper bero på domänen.
function isTransientError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'SHARD_UNAVAILABLE'
  );
}

async function handleMessage(
  channel: Channel,
  message: ConsumeMessage,
  options: ConsumeOptions,
  handler: MessageHandler,
  onHandlerError: (error: unknown, messageId: string | undefined) => void,
): Promise<void> {
  const messageId = readMessageId(message);
  try {
    const payload = parseMessage(message);
    await handler(payload, messageId);
    channel.ack(message);
  } catch (error) {
    onHandlerError(error, messageId);
    // Gränsen nådd: requeue=false dead-letterar meddelandet (policyn) i stället för att köa om det.
    const isTransient = isTransientError(error) || options.isTransient?.(error) === true;
    const isLastAttempt =
      !isTransient && readAcquiredCount(message) + 1 >= options.deliveryLimit;
    channel.nack(message, false, !isLastAttempt);
  }
}

interface ConnectionState {
  closed: boolean;
  current: { connection: ChannelModel; channel: Channel } | undefined;
}

type ConnectionErrorReporter = ((error: unknown) => void) | undefined;

async function reconnectWithBackoff(
  url: string,
  options: ConsumeOptions,
  handler: MessageHandler,
  onHandlerError: (error: unknown, messageId: string | undefined) => void,
  onConnectionError: ConnectionErrorReporter,
  state: ConnectionState,
): Promise<void> {
  let delay = RECONNECT_INITIAL_DELAY_MS;
  while (!state.closed) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (state.closed) {
      return;
    }
    try {
      await establishConnection(
        url,
        options,
        handler,
        onHandlerError,
        onConnectionError,
        state,
      );
      return;
    } catch (error) {
      onConnectionError?.(error);
      delay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS);
    }
  }
}

async function establishConnection(
  url: string,
  options: ConsumeOptions,
  handler: MessageHandler,
  onHandlerError: (error: unknown, messageId: string | undefined) => void,
  onConnectionError: ConnectionErrorReporter,
  state: ConnectionState,
): Promise<void> {
  const connection: ChannelModel = await connect(url);
  const channel = await connection.createChannel();
  await channel.prefetch(options.prefetch ?? 10);
  await setUpQueue(channel, options);

  await channel.consume(options.queue, (message) => {
    if (message === null) {
      return;
    }
    void handleMessage(channel, message, options, handler, onHandlerError);
  });

  const onConnectionLost = (error: unknown): void => {
    onConnectionError?.(error);
    if (state.closed) {
      return;
    }
    void reconnectWithBackoff(url, options, handler, onHandlerError, onConnectionError, state);
  };
  connection.on('error', (error: unknown) => onConnectionLost(error));
  connection.on('close', () => onConnectionLost(new Error('RabbitMQ connection closed')));
  channel.on('error', (error: unknown) => onConnectionError?.(error));

  state.current = { connection, channel };
}

export async function connectConsumer(
  url: string,
  options: ConsumeOptions,
  handler: MessageHandler,
  onHandlerError: (error: unknown, messageId: string | undefined) => void,
  onConnectionError?: (error: unknown) => void,
): Promise<RabbitConsumer> {
  const state: ConnectionState = { closed: false, current: undefined };
  await establishConnection(url, options, handler, onHandlerError, onConnectionError, state);

  return {
    async close() {
      state.closed = true;
      if (state.current !== undefined) {
        await state.current.channel.close();
        await state.current.connection.close();
      }
    },
  };
}
