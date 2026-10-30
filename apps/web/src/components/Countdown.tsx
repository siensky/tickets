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

export function useRemainingSeconds(expiresAt: string): number {
  const [seconds, setSeconds] = useState(() => remainingSeconds(expiresAt));

  useEffect(() => {
    setSeconds(remainingSeconds(expiresAt));
    const timer = setInterval(() => setSeconds(remainingSeconds(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return seconds;
}

export function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${(totalSeconds % 60).toString().padStart(2, '0')}`;
}

// `role="timer"` är tyst för skärmläsare som standard (implicit aria-live="off"), så en
// uppdatering varje sekund läses inte upp. Varningen under 60 s ligger i ReservationTimer.
export function Countdown({ expiresAt }: { expiresAt: string }): JSX.Element {
  return (
    <span role="timer" className="tabular-nums">
      {formatClock(useRemainingSeconds(expiresAt))}
    </span>
  );
}
