import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import { RedisIoAdapter } from './redis-io.adapter';

describe('RedisIoAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('turns off skipMiddlewares, so a recovered connection is authenticated at the handshake again', () => {
    const createIOServer = jest
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue({ adapter: jest.fn() } as never);

    new RedisIoAdapter(jest.fn()).createIOServer(0, {} as ServerOptions);

    expect(createIOServer).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ connectionStateRecovery: expect.objectContaining({ skipMiddlewares: false }) }),
    );
  });

  it('hands the Host check to engine.io, which answers ahead of Express (#977)', () => {
    const createIOServer = jest
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue({ adapter: jest.fn() } as never);
    const allowRequest = jest.fn();

    new RedisIoAdapter(allowRequest).createIOServer(0, {} as ServerOptions);

    expect(createIOServer).toHaveBeenCalledWith(0, expect.objectContaining({ allowRequest }));
  });

  it("keeps the Host check when a gateway's options name their own allowRequest (#977)", () => {
    const createIOServer = jest
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue({ adapter: jest.fn() } as never);
    const allowRequest = jest.fn();

    new RedisIoAdapter(allowRequest).createIOServer(0, { allowRequest: jest.fn() } as unknown as ServerOptions);

    expect(createIOServer).toHaveBeenCalledWith(0, expect.objectContaining({ allowRequest }));
  });
});
