/**
 * E-postutskick (docs/plan.md "Tjänster": "e-post, QR, push"). Ingen
 * riktig e-postleverantör är godkänd som beroende (docs/rules.md §11:
 * "Inga nya beroenden utan att fråga först") — precis som payment-mock
 * SIMULERAR Stripe, simuleras utskicket här med en strukturerad loggrad
 * i stället för ett verkligt leverantörs-API-anrop. Bytet till en riktig
 * leverantör är en isolerad ändring i den här filen den dagen den görs.
 */
import type { Logger } from '@tickets/observability';

export function sendOrderConfirmationEmail(
  logger: Logger,
  params: { email: string; orderId: string; ticketIds: readonly string[] },
): void {
  logger.info(
    { email: params.email, orderId: params.orderId, ticketCount: params.ticketIds.length },
    'simulated: order confirmation email with QR codes sent',
  );
}

export function sendRefundEmail(
  logger: Logger,
  params: { email: string; orderId: string },
): void {
  logger.info(
    { email: params.email, orderId: params.orderId },
    'simulated: refund explanation email sent',
  );
}
