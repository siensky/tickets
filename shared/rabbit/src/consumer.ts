/**
 * Delad konsumentbas för RabbitMQ (docs/plan.md "Idempotens": "Delivery
 * limit på RabbitMQ-köerna (quorum-kö med `x-delivery-limit` ...)").
 *
 * `x-queue-type: quorum` + `x-delivery-limit` gör att mäklaren SJÄLV
 * slutar leverera om ett meddelande ett giftigt meddelande nackas
 * (requeue=true) fler än `deliveryLimit` gånger — konsumentkoden
 * behöver aldrig själv räkna försök. Utan detta ger ett giftigt
 * meddelande evig redelivery → växande ködjup → KEDA skalar till 10
 * kraschloopande poddar mitt i lastdemon (docs/plan.md "Idempotens").
 *
 * Ingen dead-letter-exchange är bunden här — en adminvy för en DLQ är
 * medvetet flyttad till efter inlämningen (docs/plan.md "Fasplan").
 * Mäklaren tappar meddelandet tyst efter gränsen; `handler`-anroparen
 * loggar varje nack, så det syns i loggarna även utan en DLQ-vy.
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

const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

export interface ConsumeOptions {
  readonly exchange: string;
  readonly queue: string;
  readonly routingKey: string;
  readonly deliveryLimit: number;
  readonly prefetch?: number;
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

async function handleMessage(
  channel: Channel,
  message: ConsumeMessage,
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
    // requeue=true: mäklaren räknar själv mot x-delivery-limit ovan,
    // och ger upp åt oss när gränsen nås.
    channel.nack(message, false, true);
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
    void handleMessage(channel, message, handler, onHandlerError);
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
