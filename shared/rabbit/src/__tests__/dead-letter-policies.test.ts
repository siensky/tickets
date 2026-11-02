/**
 * Varje kö som en tjänst deklarerar via connectConsumer måste ha en dead-letter-policy i
 * infra/k8s/base/rabbitmq/definitions.json (docs/plan.md 8.6). Utan policy kastas ett meddelande som nackas
 * med requeue=false tyst, så ett nytt könamn eller ett stavfel får inte kunna slinka förbi.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');

function declaredQueues(): string[] {
  return [
    'services/booking-api/src/index.ts',
    'services/notification-worker/src/index.ts',
  ].flatMap((file) =>
    [...readFileSync(resolve(root, file), 'utf8').matchAll(/_QUEUE = '([^']+)'/g)].map(
      (match) => match[1] ?? '',
    ),
  );
}

interface Policy {
  pattern: string;
  definition: Record<string, string>;
}

describe('dead-letter-policyer', () => {
  const definitions = JSON.parse(
    readFileSync(resolve(root, 'infra/k8s/base/rabbitmq/definitions.json'), 'utf8'),
  ) as { policies: Policy[] };

  it('hittar tjänsternas köer', () => {
    expect(declaredQueues()).toHaveLength(2);
  });

  it.each(declaredQueues())(
    '%s har en policy som pekar på tickets.dlx med kön som routing key',
    (queue) => {
      const matching = definitions.policies.filter((policy) =>
        new RegExp(policy.pattern).test(queue),
      );

      expect(matching).toHaveLength(1);
      expect(matching[0]?.definition).toEqual({
        'dead-letter-exchange': 'tickets.dlx',
        'dead-letter-routing-key': queue,
      });
    },
  );

  it('matchar aldrig en dödkö (ingen loop)', () => {
    for (const queue of declaredQueues()) {
      expect(
        definitions.policies.some((p) => new RegExp(p.pattern).test(`${queue}.dead`)),
      ).toBe(false);
    }
  });
});
