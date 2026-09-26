import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import { RedisIoAdapter } from './redis-io.adapter';

describe('RedisIoAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('turns off skipMiddlewares, so a recovered connection is authenticated at the handshake again', () => {
    const createIOServer = jest
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue({ adapter: jest.fn() } as never);

    new RedisIoAdapter().createIOServer(0, {} as ServerOptions);

    expect(createIOServer).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ connectionStateRecovery: expect.objectContaining({ skipMiddlewares: false }) }),
    );
  });
});
