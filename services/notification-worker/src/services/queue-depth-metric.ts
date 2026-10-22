/**
 * Exponerar RabbitMQ-ködjupet som en egen Prometheus-gauge (docs/plan.md
 * "Tjänster": notification-worker, "1–10 (KEDA på ködjup)"). KEDA kan
 * skala direkt mot RabbitMQs management-API — denna gauge är ett
 * ALTERNATIV som håller autoskalningssignalen i samma Prometheus-stack
 * som allt annat observability (docs/plan.md "Observability": "Prometheus
 * hämtar (pull)"), i stället för att ge KEDA egna RabbitMQ-uppgifter.
 * Fas 3 bygger gaugen; den faktiska KEDA `ScaledObject`-kopplingen mot
 * den är fas 6 (docs/plan.md "Fasplan").
 *
 * Egen anslutning, separat från konsumentens (@tickets/rabbit) — ett
 * `checkQueue`-anrop per poll på en delad kanal hade kapplöpt mot
 * konsumentens egna `ack`/`nack`-anrop på samma kanal.
 */
import { connect, type ChannelModel } from 'amqplib';
import type { Logger } from '@tickets/observability';
import { Gauge, type Registry } from 'prom-client';

export function createQueueDepthGauge(registry: Registry): Gauge<'queue'> {
  return new Gauge({
    name: 'rabbitmq_queue_messages_ready',
    help: 'Ready message count for the notification-worker queue (KEDA scaling signal)',
    labelNames: ['queue'],
    registers: [registry],
  });
}

export interface QueueDepthPoll {
  stop(): Promise<void>;
}

async function pollOnce(
  connection: ChannelModel,
  queue: string,
  gauge: Gauge<'queue'>,
  logger: Logger,
): Promise<void> {
  const channel = await connection.createChannel();
  try {
    const result = await channel.checkQueue(queue);
    gauge.set({ queue }, result.messageCount);
  } catch (error) {
    logger.warn({ error, queue }, 'failed to poll RabbitMQ queue depth');
  } finally {
    await channel.close();
  }
}

export async function startQueueDepthPoll(
  url: string,
  queue: string,
  gauge: Gauge<'queue'>,
  logger: Logger,
  intervalMs = 5000,
): Promise<QueueDepthPoll> {
  const connection = await connect(url);
  const timer = setInterval(() => {
    pollOnce(connection, queue, gauge, logger).catch((error: unknown) => {
      logger.warn({ error }, 'queue depth poll tick failed');
    });
  }, intervalMs);
  return {
    async stop() {
      clearInterval(timer);
      await connection.close();
    },
  };
}
