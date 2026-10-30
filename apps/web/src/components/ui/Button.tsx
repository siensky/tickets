/**
 * Knappen i designsystemet (docs/plan.md 7.11): primary · secondary (ink-outline) · ghost ·
 * link, tre storlekar. `loading` = spinner + aria-busy + disabled. `buttonClass` delas med
 * länkar som ska se ut som knappar, så att båda använder samma klasser.
 */
import type { ButtonHTMLAttributes, JSX } from 'react';
import { Spinner } from './Spinner.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-outline btn-neutral',
  ghost: 'btn-ghost',
  link: 'btn-link text-accent',
};
const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'btn-sm min-h-9',
  md: 'min-h-11',
  lg: 'btn-lg min-h-12',
};

export function buttonClass(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  extra = '',
): string {
  return `btn ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${extra}`.trim();
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className = '',
  disabled,
  type = 'button',
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <Spinner size="sm" /> : null}
      {children}
    </button>
  );
}
