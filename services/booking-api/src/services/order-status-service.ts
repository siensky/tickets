/**
 * Orderstatus för bekräftelsesidan (docs/plan.md 7.13 E6). Okänd användare,
 * okänd order och annans order ger samma `NotFoundError` (docs/rules.md §6),
 * så svaret avslöjar inte om ordern finns. Användaren slås bara upp, aldrig
 * skapas (till skillnad från `ensureUser` i checkout).
 */
import { getGlobalPool, getPoolForEvent, type ShardPools } from '@tickets/db';
import { NotFoundError } from '@tickets/domain';
import { getOrderForUser } from '../repositories/orders-repository.js';
import { getUserByAuth0Sub } from '../repositories/users-repository.js';
import { toOrderStatusView } from '../mappers/order-mapper.js';
import type { OrderStatusView } from '../types/order.js';

export interface OrderStatusServiceDeps {
  readonly shardPools: ShardPools;
}

export async function getOrderStatusForAuth0User(
  deps: OrderStatusServiceDeps,
  params: { auth0Sub: string; eventId: string; orderId: string },
): Promise<OrderStatusView> {
  const user = await getUserByAuth0Sub(getGlobalPool(deps.shardPools), params.auth0Sub);
  const order =
    user === undefined
      ? undefined
      : await getOrderForUser(
          getPoolForEvent(deps.shardPools, params.eventId),
          params.eventId,
          params.orderId,
          user.id,
        );
  if (order === undefined) {
    throw new NotFoundError(`Order ${params.orderId} not found`, { orderId: params.orderId });
  }
  return toOrderStatusView(order);
}
