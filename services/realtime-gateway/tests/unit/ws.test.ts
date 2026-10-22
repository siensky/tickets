import { createQueueTokenSecret, issueQueueToken } from '@tickets/auth';
import type { RedisClient } from '@tickets/redis';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleConnection, type WsRouteDeps } from '../../src/routes/ws.js';

const SECRET = createQueueTokenSecret('ws-test-secret-at-least-32-bytes!!');

// subscribeToChannel (@tickets/redis) duplicates the connection — the
// fake only needs to satisfy that one call, plus `exists` for the
// revocation check.
function fakeDeps(revoked: boolean): {
  deps: WsRouteDeps;
  subscriberOn: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  const subscriberOn = vi.fn();
  const subscribe = vi.fn().mockResolvedValue(undefined);
  const unsubscribe = vi.fn().mockResolvedValue(undefined);
  const quit = vi.fn().mockResolvedValue(undefined);
  const subscriber = { on: subscriberOn, subscribe, unsubscribe, quit };
  const redis = {
    exists: vi.fn().mockResolvedValue(revoked ? 1 : 0),
    duplicate: vi.fn().mockReturnValue(subscriber),
  } as unknown as RedisClient;
  return { deps: { redis, queueTokenSecret: SECRET }, subscriberOn, subscribe, unsubscribe };
}

function fakeRequest(): FastifyRequest {
  return {} as unknown as FastifyRequest;
}

function fakeSocket(): {
  socket: {
    OPEN: 1;
    readyState: number;
    close: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    ping: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
  };
  emitClose: () => void;
  emitMessage: (data: string) => void;
} {
  const closeHandlers: (() => void)[] = [];
  let messageHandler: ((data: unknown) => void) | undefined;
  const socket = {
    OPEN: 1 as const,
    readyState: 1,
    close: vi.fn(),
    send: vi.fn(),
    ping: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'close') {
        closeHandlers.push(handler);
      }
    }),
    once: vi.fn((event: string, handler: (data?: unknown) => void) => {
      if (event === 'message') {
        messageHandler = handler;
      } else if (event === 'close') {
        closeHandlers.push(handler);
      }
    }),
  };
  return {
    socket,
    emitClose: () => closeHandlers.forEach((handler) => handler()),
    emitMessage: (data: string) => messageHandler?.(data),
  };
}

describe('handleConnection', () => {
  it('closes with 4001 when the first message has no token field', async () => {
    const { deps } = fakeDeps(false);
    const { socket, emitMessage } = fakeSocket();

    const handled = handleConnection(socket as never, fakeRequest(), deps);
    emitMessage(JSON.stringify({}));
    await handled;

    expect(socket.close).toHaveBeenCalledWith(4001, expect.any(String));
  });

  it('closes with 4001 when the token signature is invalid', async () => {
    const { deps } = fakeDeps(false);
    const { socket, emitMessage } = fakeSocket();

    const handled = handleConnection(socket as never, fakeRequest(), deps);
    emitMessage(JSON.stringify({ token: 'garbage' }));
    await handled;

    expect(socket.close).toHaveBeenCalledWith(4001, expect.any(String));
  });

  it('closes with 4001 when the token has been revoked', async () => {
    const { deps } = fakeDeps(true);
    const issued = await issueQueueToken(SECRET, 'event-1', 900);
    const { socket, emitMessage } = fakeSocket();

    const handled = handleConnection(socket as never, fakeRequest(), deps);
    emitMessage(JSON.stringify({ token: issued.token }));
    await handled;

    expect(socket.close).toHaveBeenCalledWith(4001, expect.any(String));
  });

  it('subscribes to the token-scoped channel and forwards a published message to the socket', async () => {
    const { deps, subscriberOn, subscribe } = fakeDeps(false);
    const issued = await issueQueueToken(SECRET, 'event-1', 900);
    const { socket, emitMessage } = fakeSocket();

    const handled = handleConnection(socket as never, fakeRequest(), deps);
    emitMessage(JSON.stringify({ token: issued.token }));
    await handled;

    expect(socket.close).not.toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith(`ws:${issued.queueTokenId}`);

    const onMessage = subscriberOn.mock.calls.find((call) => call[0] === 'message')?.[1] as
      ((channel: string, raw: string) => void) | undefined;
    onMessage?.(`ws:${issued.queueTokenId}`, JSON.stringify({ type: 'admitted' }));

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'admitted' }));
  });

  it('unsubscribes when the socket closes', async () => {
    const { deps, unsubscribe } = fakeDeps(false);
    const issued = await issueQueueToken(SECRET, 'event-1', 900);
    const { socket, emitMessage, emitClose } = fakeSocket();

    const handled = handleConnection(socket as never, fakeRequest(), deps);
    emitMessage(JSON.stringify({ token: issued.token }));
    await handled;

    emitClose();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
  });

  it('never subscribes if the socket disconnects before sending its token', async () => {
    const { deps, subscribe } = fakeDeps(false);
    const { socket, emitClose } = fakeSocket();

    const handled = handleConnection(socket as never, fakeRequest(), deps);
    socket.readyState = 3; // CLOSED
    emitClose();
    await handled;

    expect(subscribe).not.toHaveBeenCalled();
  });
});
