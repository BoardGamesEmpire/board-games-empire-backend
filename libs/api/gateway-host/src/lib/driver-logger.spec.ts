import { Logger } from '@nestjs/common';
import { createDriverLogger } from './driver-logger';

/** A remote DataGateway's driver logs through the app's Nest logger, under the context it names (#1082). */
describe('createDriverLogger', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['info', 'log'],
    ['debug', 'debug'],
    ['warn', 'warn'],
    ['error', 'error'],
  ] as const)('writes %s through Logger.%s, with the context', (level, method) => {
    const write = jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined);

    createDriverLogger('BoardGameGeekDriver')[level]('searchGames found 5 results');

    expect(write).toHaveBeenCalledWith('searchGames found 5 results');
    expect(write.mock.contexts[0]).toMatchObject({ context: 'BoardGameGeekDriver' });
  });
});
