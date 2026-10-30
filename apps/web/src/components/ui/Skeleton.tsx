/** Platshållare med samma form som innehållet, så att layouten inte hoppar. */
import type { JSX } from 'react';

export function Skeleton({ className = '' }: { className?: string }): JSX.Element {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}
