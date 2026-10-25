/**
 * "Mina biljetter" (docs/plan.md "Databas": "Mina ordrar via
 * scatter-gather" — `orders.user_id` has no FK, so a user's purchases
 * are scattered across both shards). Scoped on the AUTHENTICATED user's
 * own id throughout (docs/rules.md §6: IDOR) — the caller must pass the
 * id read from the verified Auth0 token, never one from a request param.
 */
import { getGlobalPool, type ShardPools } from '@tickets/db';
import type { Logger } from '@tickets/observability';
import type { Pool } from 'pg';
import { getEventTitlesByIds } from '../repositories/events-repository.js';
import { getOrdersForUser } from '../repositories/orders-repository.js';
import { getTicketsWithSeatsForOrders } from '../repositories/tickets-repository.js';
import { getUserByAuth0Sub } from '../repositories/users-repository.js';
import { toMyTicket, toMyTicketOrder } from '../mappers/my-tickets-mapper.js';
import type { MyTicketOrder, TicketWithSeatRow } from '../types/my-tickets.js';

export interface MyTicketsServiceDeps {
  readonly shardPools: ShardPools;
  readonly logger: Logger;
}

/**
 * Resolves the caller's own `auth0Sub` to a `users.id` and lists their
 * tickets (docs/rules.md §6: IDOR) — the ONLY entry point this file
 * exposes to the controller, so the repository layer never leaks
 * upward (docs/rules.md §1).
 */
export async function listMyTicketsForAuth0User(
  deps: MyTicketsServiceDeps,
  auth0Sub: string,
): Promise<MyTicketOrder[]> {
  const user = await getUserByAuth0Sub(getGlobalPool(deps.shardPools), auth0Sub);
  if (user === undefined) {
    // Never reached checkout yet — a real, empty result, not an error.
    return [];
  }
  return listMyTickets(deps, user.id);
}

/**
 * Scatter-gather across both shards for an already-resolved user id —
 * exported separately so its merge behavior can be tested directly.
 * `allSettled`: one unreachable shard must still let the user see
 * tickets bought on the other (docs/plan.md's shard-failure demo).
 */
export async function listMyTickets(
  deps: MyTicketsServiceDeps,
  userId: string,
): Promise<MyTicketOrder[]> {
  const outcomes = await Promise.allSettled(
    deps.shardPools.pools.map((pool) => listOrdersWithTicketsOnShard(pool, userId)),
  );
  return outcomes.flatMap((outcome, shardIndex) => {
    if (outcome.status === 'rejected') {
      deps.logger.warn(
        { error: outcome.reason, shardIndex },
        'listMyTickets: one shard failed, returning a partial result',
      );
      return [];
    }
    return outcome.value;
  });
}

function groupTicketsByOrder(
  tickets: readonly TicketWithSeatRow[],
): Map<string, TicketWithSeatRow[]> {
  const grouped = new Map<string, TicketWithSeatRow[]>();
  for (const ticket of tickets) {
    const existing = grouped.get(ticket.orderId);
    if (existing === undefined) {
      grouped.set(ticket.orderId, [ticket]);
    } else {
      existing.push(ticket);
    }
  }
  return grouped;
}

async function listOrdersWithTicketsOnShard(
  pool: Pool,
  userId: string,
): Promise<MyTicketOrder[]> {
  const orders = await getOrdersForUser(pool, userId);
  if (orders.length === 0) {
    return [];
  }
  const [tickets, titles] = await Promise.all([
    getTicketsWithSeatsForOrders(
      pool,
      orders.map((order) => order.id),
      orders.map((order) => order.eventId),
    ),
    getEventTitlesByIds(
      pool,
      orders.map((order) => order.eventId),
    ),
  ]);
  const ticketsByOrder = groupTicketsByOrder(tickets);
  return orders.map((order) =>
    toMyTicketOrder(
      order,
      titles.get(order.eventId) ?? 'Unknown event',
      (ticketsByOrder.get(order.id) ?? []).map(toMyTicket),
    ),
  );
}
