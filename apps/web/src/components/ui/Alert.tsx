/** Alert med ikon + text, aldrig bara färg (docs/plan.md 7.11). */
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import type { JSX, ReactNode } from 'react';

export type AlertTone = 'info' | 'success' | 'warning' | 'error';

// Neutral yta med färgad kant och ikon: grönt klarar bara 3:1, så text ligger aldrig på färgen.
const TONE: Record<AlertTone, { className: string; Icon: typeof Info }> = {
  info: { className: 'border-info text-info', Icon: Info },
  success: { className: 'border-success text-success', Icon: CheckCircle2 },
  warning: { className: 'border-warning text-warning', Icon: AlertTriangle },
  error: { className: 'border-error text-error', Icon: XCircle },
};

export function Alert({
  tone = 'info',
  children,
  role,
}: {
  tone?: AlertTone;
  children: ReactNode;
  role?: 'alert' | 'status';
}): JSX.Element {
  const { className, Icon } = TONE[tone];
  return (
    <div
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      className={`alert border-0 border-l-4 bg-base-200 ${className}`}
    >
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      <div className="text-base-content">{children}</div>
    </div>
  );
}
