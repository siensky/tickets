/** Liten laddningsindikator. Dold för skärmläsare: knappen/sektionen bär `aria-busy`. */
import type { JSX } from 'react';

const SIZE_CLASS = { sm: 'loading-sm', md: 'loading-md', lg: 'loading-lg' } as const;

export function Spinner({ size = 'md' }: { size?: keyof typeof SIZE_CLASS }): JSX.Element {
  return <span className={`loading loading-spinner ${SIZE_CLASS[size]}`} aria-hidden="true" />;
}
