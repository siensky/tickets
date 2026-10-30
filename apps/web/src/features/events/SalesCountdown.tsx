/** Nedräkning till att försäljningen öppnar, uppdateras varje sekund. */
import { useEffect, useState, type JSX } from 'react';

function parts(openAt: string): { days: number; clock: string } {
  const total = Math.max(0, Math.floor((new Date(openAt).getTime() - Date.now()) / 1000));
  const two = (n: number): string => n.toString().padStart(2, '0');
  return {
    days: Math.floor(total / 86_400),
    clock: `${two(Math.floor((total % 86_400) / 3600))}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`,
  };
}

export function SalesCountdown({ openAt }: { openAt: string }): JSX.Element {
  const [now, setNow] = useState(() => parts(openAt));
  useEffect(() => {
    const timer = setInterval(() => setNow(parts(openAt)), 1000);
    return () => clearInterval(timer);
  }, [openAt]);
  return (
    <p className="tabular-nums">
      Biljetterna släpps om{' '}
      <strong>
        {now.days > 0 ? `${now.days} d ` : ''}
        {now.clock}
      </strong>
    </p>
  );
}
