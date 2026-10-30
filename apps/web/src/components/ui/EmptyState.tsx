/** Tomt tillstånd: ikon, rubrik, förklaring och valfri åtgärd. */
import type { LucideIcon } from 'lucide-react';
import type { JSX, ReactNode } from 'react';

export function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <Icon size={32} strokeWidth={1.75} className="text-muted" aria-hidden="true" />
      <h2 className="text-lg">{title}</h2>
      {children === undefined ? null : <div className="max-w-md text-muted">{children}</div>}
    </div>
  );
}
