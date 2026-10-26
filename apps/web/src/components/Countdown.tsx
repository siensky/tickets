/**
 * Server-driven countdown (docs/plan.md "Realtid": "Reservationsnedräkning
 * | Serverstyrd, så klienten inte kan fuska till sig extra tid"). Takes
 * the server's `expiresAt` and only computes the remaining time against
 * the client clock for DISPLAY — the server's own expiry check is what
 * actually matters, this never grants extra time on its own.
 */
import { useEffect, useState, type JSX } from 'react';

function remainingSeconds(expiresAt: string): number {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

export function Countdown({ expiresAt }: { expiresAt: string }): JSX.Element {
  const [seconds, setSeconds] = useState(() => remainingSeconds(expiresAt));

  useEffect(() => {
    setSeconds(remainingSeconds(expiresAt));
    const timer = setInterval(() => setSeconds(remainingSeconds(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return (
    <span role="timer" aria-live="polite">
      {minutes}:{secs.toString().padStart(2, '0')}
    </span>
  );
}
