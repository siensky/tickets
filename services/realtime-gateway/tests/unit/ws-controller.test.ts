import { createQueueTokenSecret, issueQueueToken } from '@tickets/auth';
import type { RedisClient } from '@tickets/redis';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleConnection, type WsRouteDeps } from '../../src/controllers/ws-controller.js';
import type {
  WsMessageHandler,
  WsSubscriberRegistry,
} from '../../src/services/ws-subscriber-registry.js';

const SECRET = createQueueTokenSecret('ws-test-secret-at-least-32-bytes!!');

// register() is now local/synchronous (no Redis connection per socket,
// see ws-subscriber-registry.ts) — the fake just needs to record the
// queueTokenId/handler pair and hand back an unregister spy.
function fakeDeps(revoked: boolean): {
  deps: WsRouteDeps;
  register: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
  registeredHandlers: Map<string, WsMessageHandler>;
} {
  const unregister = vi.fn();
  const registeredHandlers = new Map<string, WsMessageHandler>();
  const register = vi.fn((queueTokenId: string, onMessage: WsMessageHandler) => {
    registeredHandlers.set(queueTokenId, onMessage);
    return unregister;
  });
  const wsSubscribers = { register, close: vi.fn() } as unknown as WsSubscriberRegistry;
  const redis = {
    exists: vi.fn().mockResolvedValue(revoked ? 1 : 0),
  } as unknown as RedisClient;
  return {
    deps: { redis, wsSubscribers, queueTokenSecret: SECRET },
    register,
    unregister,
    registeredHandlers,
  };
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

  it('registers against the token-scoped queue id and forwards a published message to the socket', async () => {
    const { deps, register, registeredHandlers } = fakeDeps(false);
    const issued = await issueQueueToken(SECRET, 'event-1', 900);
    const { socket, emitMessage } = fakeSocket();

    const handled = handleConnection(socket as never, fakeRequest(), deps);
    emitMessage(JSON.stringify({ token: issued.token }));
    await handled;

    expect(socket.close).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith(issued.queueTokenId, expect.any(Function));

    registeredHandlers.get(issued.queueTokenId)?.({ type: 'admitted' });

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'admitted' }));
  });

  it('unregisters when the socket closes', async () => {
    const { deps, unregister } = fakeDeps(false);
    const issued = await issueQueueToken(SECRET, 'event-1', 900);
    const { socket, emitMessage, emitClose } = fakeSocket();

    const handled = handleConnection(socket as never, fakeRequest(), deps);
    emitMessage(JSON.stringify({ token: issued.token }));
    await handled;

    emitClose();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('never registers if the socket disconnects before sending its token', async () => {
    const { deps, register } = fakeDeps(false);
    const { socket, emitClose } = fakeSocket();

    const handled = handleConnection(socket as never, fakeRequest(), deps);
    socket.readyState = 3; // CLOSED
    emitClose();
    await handled;

    expect(register).not.toHaveBeenCalled();
  });
});
