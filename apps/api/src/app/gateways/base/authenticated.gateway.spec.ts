import { AuthService } from '@bge/auth';
import { Logger } from '@nestjs/common';
import type { Namespace, Socket } from 'socket.io';
import { WsConnectionRefusal } from '../filters';
import { AuthenticatedGateway } from './authenticated.gateway';
import type { WsFrameScope } from './ws-frame-scope';

class TestGateway extends AuthenticatedGateway {
  protected readonly logger = new Logger(TestGateway.name);
}

class OtherTestGateway extends AuthenticatedGateway {
  protected readonly logger = new Logger(OtherTestGateway.name);
}

type Middleware = (client: Socket, next: (error?: Error) => void) => void;

/** A namespace that records the middleware gateways register on it. */
function fakeNamespace(): { namespace: Namespace; middleware: Middleware[] } {
  const middleware: Middleware[] = [];
  const namespace = { use: (fn: Middleware) => middleware.push(fn) } as unknown as Namespace;

  return { namespace, middleware };
}

/** Runs a connection through every middleware, in order, until one refuses it. */
async function handshake(middleware: Middleware[], client: Socket): Promise<Error | undefined> {
  for (const fn of middleware) {
    const refusal = await new Promise<Error | undefined>((next) => fn(client, next));
    if (refusal) {
      return refusal;
    }
  }

  return undefined;
}

const frameScope = { bind: jest.fn() } as unknown as WsFrameScope;

const connection = (): Socket =>
  ({
    id: 'socket-1',
    handshake: { auth: { token: 'token-1' }, headers: {} },
    data: {},
    onAny: jest.fn(),
  }) as unknown as Socket;

describe('AuthenticatedGateway', () => {
  afterEach(() => jest.restoreAllMocks());

  it('refuses a connection whose session cannot be looked up with a 500, and logs why', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const outage = new Error('connect ECONNREFUSED redis:6379');
    const authService = { getSessionFromToken: jest.fn().mockRejectedValue(outage) } as unknown as AuthService;
    const { namespace, middleware } = fakeNamespace();

    new TestGateway(authService, frameScope).afterInit(namespace);
    const refusal = await handshake(middleware, connection());

    // The client reads the message and `data` on `connect_error`; neither
    // names the cause.
    expect(refusal).toBeInstanceOf(WsConnectionRefusal);
    expect(refusal).toMatchObject({
      message: 'Internal server error',
      data: { statusCode: 500, error: 'Internal Server Error', message: 'Internal server error' },
    });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('socket-1'), outage);
  });

  it("looks up a connection's session once, however many gateways share its namespace", async () => {
    const getSessionFromToken = jest.fn().mockResolvedValue(null);
    const authService = { getSessionFromToken, isValidSession: () => false } as unknown as AuthService;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { namespace, middleware } = fakeNamespace();

    new TestGateway(authService, frameScope).afterInit(namespace);
    new OtherTestGateway(authService, frameScope).afterInit(namespace);
    await handshake(middleware, connection());

    expect(getSessionFromToken).toHaveBeenCalledTimes(1);
  });
});
