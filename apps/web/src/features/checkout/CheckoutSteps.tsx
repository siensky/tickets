/** Stegindikatorn Platser → Granska → Betala → Klart (docs/plan.md 7.11 F). */
import type { JSX } from 'react';

const STEPS = ['Platser', 'Granska', 'Betala', 'Klart'] as const;
export type CheckoutStep = (typeof STEPS)[number];

export function CheckoutSteps({ current }: { current: CheckoutStep }): JSX.Element {
  const currentIndex = STEPS.indexOf(current);
  return (
    <ol className="steps w-full" aria-label="Steg i bokningen">
      {STEPS.map((step, index) => (
        <li
          key={step}
          className={`step ${index <= currentIndex ? 'step-primary' : ''}`}
          aria-current={index === currentIndex ? 'step' : undefined}
        >
          {step}
        </li>
      ))}
    </ol>
  );
}
