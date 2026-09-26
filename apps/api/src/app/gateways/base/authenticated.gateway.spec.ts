import { AuthService } from '@bge/auth';
import { WsErrorEvents } from '@bge/shared';
import { Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { AuthenticatedGateway } from './authenticated.gateway';

class TestGateway extends AuthenticatedGateway {
  protected readonly logger = new Logger(TestGateway.name);
}

describe('AuthenticatedGateway', () => {
  afterEach(() => jest.restoreAllMocks());

  it('answers a connection whose session cannot be looked up on `auth:error` with a 500, then disconnects it', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const outage = new Error('connect ECONNREFUSED redis:6379');
    const authService = { getSessionFromToken: jest.fn().mockRejectedValue(outage) } as unknown as AuthService;
    const client = {
      id: 'socket-1',
      handshake: { auth: { token: 'token-1' }, headers: {} },
      emit: jest.fn(),
      disconnect: jest.fn(),
    };

    // Nest does not await this hook, so it must never reject.
    await expect(new TestGateway(authService).handleConnection(client as unknown as Socket)).resolves.toBeUndefined();

    expect(client.emit).toHaveBeenCalledTimes(1);
    expect(client.emit).toHaveBeenCalledWith(WsErrorEvents.AuthError, {
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal server error',
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('socket-1'), outage);
  });
});
