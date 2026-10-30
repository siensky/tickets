/** Kort: `shadow-sm`, hover lyfter bara när kortet är klickbart (`interactive`). */
import type { JSX, ReactNode } from 'react';

export function Card({
  children,
  interactive = false,
  className = '',
}: {
  children: ReactNode;
  interactive?: boolean;
  className?: string;
}): JSX.Element {
  const hover = interactive
    ? 'transition duration-200 hover:-translate-y-0.5 hover:shadow-md'
    : '';
  return (
    <div
      className={`rounded-box border border-base-300 bg-base-100 p-4 shadow-sm sm:p-5 ${hover} ${className}`}
    >
      {children}
    </div>
  );
}
