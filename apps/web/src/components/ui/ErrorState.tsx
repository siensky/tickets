/** API-fel med "Försök igen" (kopplas till TanStack Querys `refetch`). */
import { CloudOff } from 'lucide-react';
import type { JSX } from 'react';
import { Button } from './Button.js';

export function ErrorState({
  message = 'Något gick fel. Försök igen.',
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 py-16 text-center">
      <CloudOff size={32} strokeWidth={1.75} className="text-error" aria-hidden="true" />
      <p className="max-w-md">{message}</p>
      {onRetry === undefined ? null : (
        <Button variant="secondary" onClick={onRetry}>
          Försök igen
        </Button>
      )}
    </div>
  );
}
