import type { GatewayServiceClient } from '@boardgamesempire/proto-gateway';
import type { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { pingWithRetry } from './ping.js';

describe('pingWithRetry', () => {
  const answer = { gatewayId: 'gw-1' };

  let ping: jest.Mock;
  let client: GatewayServiceClient;
  let logger: { warn: jest.Mock };

  /** Fails the first `failures` pings with `error`, then answers. */
  const failThenAnswer = (failures: number, error: Error) => {
    for (let i = 0; i < failures; i++) {
      ping.mockReturnValueOnce(throwError(() => error));
    }

    ping.mockReturnValue(of(answer));
  };

  beforeEach(() => {
    ping = jest.fn();
    client = { ping } as unknown as GatewayServiceClient;
    logger = { warn: jest.fn() };
  });

  it('tries again after any error by default, and returns the answer (#1083)', async () => {
    failThenAnswer(2, new Error('not up yet'));

    await expect(pingWithRetry(client, 'gw-1', logger as unknown as Logger, 5, 0)).resolves.toBe(answer);

    expect(ping).toHaveBeenCalledTimes(3);
  });

  it('rethrows the last error by default once every attempt fails (#1083)', async () => {
    const error = new Error('still down');
    ping.mockReturnValue(throwError(() => error));

    await expect(pingWithRetry(client, 'gw-1', logger as unknown as Logger, 3, 0)).rejects.toBe(error);

    expect(ping).toHaveBeenCalledTimes(3);
  });

  it('throws an error the predicate refuses at once, unchanged, after one attempt (#1083)', async () => {
    const error = new Error('answered with a refusal');
    failThenAnswer(1, error);
    const retryable = jest.fn(() => false);

    await expect(pingWithRetry(client, 'gw-1', logger as unknown as Logger, 5, 0, retryable)).rejects.toBe(error);

    expect(ping).toHaveBeenCalledTimes(1);
    expect(retryable).toHaveBeenCalledWith(error);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('tries again after an error the predicate accepts (#1083)', async () => {
    failThenAnswer(2, new Error('not up yet'));
    const retryable = jest.fn(() => true);

    await expect(pingWithRetry(client, 'gw-1', logger as unknown as Logger, 5, 0, retryable)).resolves.toBe(answer);

    expect(ping).toHaveBeenCalledTimes(3);
    expect(retryable).toHaveBeenCalledTimes(2);
  });
});
