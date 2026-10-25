/**
 * WebSocket client for realtime-gateway (docs/plan.md "Realtid"):
 * authenticates by sending `{"token": "..."}` as its FIRST message
 * after connecting — never in the URL (docs/rules.md §6: "aldrig
 * tokens eller hemligheter i ... URL:er"; see
 * services/realtime-gateway/src/routes/ws.ts for the server side of
 * this contract).
 *
 * Purely an optimization (docs/plan.md "WebSocket är en optimering,
 * aldrig enda leveransvägen") — every message this delivers is also
 * readable via REST polling if the socket never connects at all, so a
 * failure here must never block the UI, only reconnect with backoff.
 */
import { useEffect, useRef } from 'react';

const WS_BASE_URL = import.meta.env.VITE_WS_BASE_URL ?? 'ws://localhost:3001';
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

function parseMessage(raw: unknown): unknown {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function useQueueSocket(
  token: string | undefined,
  onMessage: (payload: unknown) => void,
): void {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (token === undefined) {
      return undefined;
    }

    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let delayMs = RECONNECT_BASE_DELAY_MS;
    let stopped = false;

    function connect(): void {
      socket = new WebSocket(`${WS_BASE_URL}/ws`);
      socket.addEventListener('open', () => {
        socket?.send(JSON.stringify({ token }));
        delayMs = RECONNECT_BASE_DELAY_MS;
      });
      socket.addEventListener('message', (event: MessageEvent) => {
        const payload = parseMessage(event.data);
        if (payload !== undefined) {
          onMessageRef.current(payload);
        }
      });
      socket.addEventListener('close', () => {
        if (stopped) {
          return;
        }
        reconnectTimer = setTimeout(connect, delayMs);
        delayMs = Math.min(delayMs * 2, RECONNECT_MAX_DELAY_MS);
      });
    }

    connect();
    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [token]);
}
