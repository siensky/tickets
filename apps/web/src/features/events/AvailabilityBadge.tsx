/** Säljstatus som badge. Texten bär budskapet; färgen är bara förstärkning. */
import type { JSX } from 'react';
import { Badge, type BadgeTone } from '../../components/ui/Badge.js';
import type { EventAvailability } from '../../lib/api-client.js';

const CONFIG: Record<EventAvailability, { label: string; tone: BadgeTone }> = {
  on_sale: { label: 'Biljetter släppta', tone: 'success' },
  few_left: { label: 'Få platser kvar', tone: 'warning' },
  sold_out: { label: 'Slutsåld', tone: 'neutral' },
  opens_soon: { label: 'Släpps snart', tone: 'primary' },
  closed: { label: 'Försäljningen stängd', tone: 'ghost' },
};

export function isBookable(availability: EventAvailability): boolean {
  return availability === 'on_sale' || availability === 'few_left';
}

export function AvailabilityBadge({
  availability,
}: {
  availability: EventAvailability;
}): JSX.Element {
  const { label, tone } = CONFIG[availability];
  return <Badge tone={tone}>{label}</Badge>;
}
