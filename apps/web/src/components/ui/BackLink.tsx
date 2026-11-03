/** Bakåtpil som länk: "← Tillbaka till …". Används överst på varje steg i bokningsflödet. */
import { ArrowLeft } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { buttonClass } from './Button.js';

export function BackLink({ to, children }: { to: string; children: ReactNode }): JSX.Element {
  return (
    <Link to={to} className={buttonClass('ghost', 'sm', 'self-start -ml-3')}>
      <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
      {children}
    </Link>
  );
}
