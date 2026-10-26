import { describe, expect, it } from 'vitest';
import {
  createBusinessMetrics,
  createHttpMetrics,
  createOversellMetrics,
  createRegistry,
} from '../metrics.js';

describe('createRegistry / createHttpMetrics', () => {
  it('registers default labels and RED metrics', async () => {
    const registry = createRegistry('test-service');
    const { requestsTotal, requestDuration } = createHttpMetrics(registry);

    requestsTotal.inc({ method: 'GET', route: '/health', status: '200' });
    requestDuration.observe({ method: 'GET', route: '/health', status: '200' }, 0.01);

    const output = await registry.metrics();
    expect(output).toContain('http_requests_total');
    expect(output).toContain('http_request_duration_seconds');
    expect(output).toContain('service="test-service"');
  });
});

describe('createOversellMetrics', () => {
  it('registers oversell_prevented_total as a counter', async () => {
    const registry = createRegistry('test-service');
    const { oversellPreventedTotal } = createOversellMetrics(registry);

    oversellPreventedTotal.inc();

    const output = await registry.metrics();
    expect(output).toContain('oversell_prevented_total{service="test-service"} 1');
  });
});

describe('createBusinessMetrics', () => {
  it('registers active_reservations/sold_tickets/waiting_room_depth as gauges that can go back down', async () => {
    const registry = createRegistry('test-service');
    const { activeReservations, soldTickets, waitingRoomDepth } =
      createBusinessMetrics(registry);

    activeReservations.set({ event_id: 'event-1' }, 5);
    soldTickets.set({ event_id: 'event-1' }, 120);
    waitingRoomDepth.set({ event_id: 'event-1' }, 4823);
    activeReservations.set({ event_id: 'event-1' }, 3);

    const output = await registry.metrics();
    expect(output).toContain(
      'active_reservations{event_id="event-1",service="test-service"} 3',
    );
    expect(output).toContain('sold_tickets{event_id="event-1",service="test-service"} 120');
    expect(output).toContain(
      'waiting_room_depth{event_id="event-1",service="test-service"} 4823',
    );
  });

  it('registers queue_joins_total/queue_admissions_total as counters', async () => {
    const registry = createRegistry('test-service');
    const { queueJoinsTotal, queueAdmissionsTotal } = createBusinessMetrics(registry);

    queueJoinsTotal.inc({ event_id: 'event-1' });
    queueJoinsTotal.inc({ event_id: 'event-1' });
    queueAdmissionsTotal.inc({ event_id: 'event-1' }, 5);

    const output = await registry.metrics();
    expect(output).toContain('queue_joins_total{event_id="event-1",service="test-service"} 2');
    expect(output).toContain(
      'queue_admissions_total{event_id="event-1",service="test-service"} 5',
    );
  });
});
