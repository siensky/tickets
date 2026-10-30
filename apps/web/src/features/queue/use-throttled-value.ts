/**
 * Släpper igenom ett nytt värde högst var `intervalMs`. Används så att köpositionen läses upp
 * (`aria-live`) sällan, medan den synliga siffran får följa varje poll.
 */
import { useEffect, useRef, useState } from 'react';

export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastUpdate = useRef(Date.now());

  useEffect(() => {
    const wait = Math.max(0, lastUpdate.current + intervalMs - Date.now());
    const timer = setTimeout(() => {
      lastUpdate.current = Date.now();
      setThrottled(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, intervalMs]);

  return throttled;
}
