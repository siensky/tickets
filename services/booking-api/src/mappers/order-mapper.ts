/**
 * Databasrad → API-objekt för orderstatus (docs/rules.md §1).
 */
import type { OrderStatusRow, OrderStatusView } from '../types/order.js';

export function toOrderStatusView(row: OrderStatusRow): OrderStatusView {
  return {
    orderId: row.id,
    eventId: row.eventId,
    status: row.status,
    totalCents: row.totalCents,
    ticketCount: row.ticketCount,
  };
}
