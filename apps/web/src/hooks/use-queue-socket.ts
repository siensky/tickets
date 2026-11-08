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
import { useEffect, useRef, useState } from 'react';

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

interface SocketHandlers {
  readonly onMessage: (payload: unknown) => void;
  readonly onOpenChange: (isOpen: boolean) => void;
}

/** Ansluter, skickar tokenet först och återansluter med backoff. Returnerar en funktion som stänger allt. */
function openReconnectingSocket(token: string, handlers: SocketHandlers): () => void {
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let delayMs = RECONNECT_BASE_DELAY_MS;
  let stopped = false;

  function connect(): void {
    socket = new WebSocket(`${WS_BASE_URL}/ws`);
    socket.addEventListener('open', () => {
      socket?.send(JSON.stringify({ token }));
      delayMs = RECONNECT_BASE_DELAY_MS;
      handlers.onOpenChange(true);
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      const payload = parseMessage(event.data);
      if (payload !== undefined) {
        handlers.onMessage(payload);
      }
    });
    socket.addEventListener('close', () => {
      handlers.onOpenChange(false);
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
}

/**
 * Returnerar om socketen är uppe och autentiserad just nu, så att den som använder den kan polla
 * oftare när den inte är det. `onOpen` körs varje gång anslutningen öppnas, även vid återanslutning:
 * ett meddelande som skickades medan socketen var nere kommer aldrig, så läget behöver läsas om.
 */
export function useQueueSocket(
  token: string | undefined,
  onMessage: (payload: unknown) => void,
  onOpen?: () => void,
): boolean {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (token === undefined) {
      return undefined;
    }
    const close = openReconnectingSocket(token, {
      onMessage: (payload) => onMessageRef.current(payload),
      onOpenChange: (open) => {
        setIsOpen(open);
        if (open) {
          onOpenRef.current?.();
        }
      },
    });
    return () => {
      close();
      setIsOpen(false);
    };
  }, [token]);

  return isOpen;
}
