import { SearchStartDto } from '@bge/game-search';
import { WsErrorEvents } from '@bge/shared';
import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { WsErrorFilter } from './ws-error.filter';

describe('WsErrorFilter', () => {
  const filter = new WsErrorFilter();

  it('sends a validation failure to the socket on `exception`, shaped like the HTTP error body', async () => {
    const payload = { correlationId: 'not-a-uuid', query: 'Gloomhaven' };
    const { client, host } = frame('search:start', payload);

    await filter.catch(await validationFailure(payload), host);

    expect(client.emit).toHaveBeenCalledTimes(1);
    expect(client.emit).toHaveBeenCalledWith(WsErrorEvents.Exception, {
      statusCode: 400,
      error: 'Bad Request',
      message: ['correlationId must be a UUID'],
      pattern: 'search:start',
      correlationId: 'not-a-uuid',
    });
  });

  it('keeps the status of any HTTP exception, including one whose body is a plain string', async () => {
    const { client, host } = frame('search:start', { correlationId: 'corr-1' });

    await filter.catch(new HttpException('ThrottlerException: Too Many Requests', 429), host);

    expect(client.emit).toHaveBeenCalledWith(WsErrorEvents.Exception, {
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'ThrottlerException: Too Many Requests',
      pattern: 'search:start',
      correlationId: 'corr-1',
    });
  });

  it.each([
    ['carries none', { query: 'Gloomhaven' }],
    ['carries a non-string one', { correlationId: 42 }],
    ['is not an object', 'search for Gloomhaven'],
  ])('echoes no correlationId when the frame %s', async (_, payload) => {
    const { client, host } = frame('search:start', payload);

    await filter.catch(new ConflictException('refused'), host);

    const [, sent] = client.emit.mock.calls[0];
    expect(sent).not.toHaveProperty('correlationId');
  });

  describe('the WsExceptions AuthGuard throws', () => {
    it('answers a frame whose session is gone on `auth:error`, then disconnects', async () => {
      const { client, host } = frame('search:start', { correlationId: 'corr-1' });

      await filter.catch(new WsException('UNAUTHORIZED'), host);

      expect(client.emit).toHaveBeenCalledTimes(1);
      expect(client.emit).toHaveBeenCalledWith(WsErrorEvents.AuthError, {
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Unauthorized',
        pattern: 'search:start',
        correlationId: 'corr-1',
      });
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.emit.mock.invocationCallOrder[0]).toBeLessThan(client.disconnect.mock.invocationCallOrder[0]);
    });

    it('refuses a frame the client may not send on `exception`, and keeps the socket open', async () => {
      const { client, host } = frame('search:start', { correlationId: 'corr-1' });

      await filter.catch(new WsException('FORBIDDEN'), host);

      expect(client.emit).toHaveBeenCalledWith(WsErrorEvents.Exception, {
        statusCode: 403,
        error: 'Forbidden',
        message: 'Insufficient permissions',
        pattern: 'search:start',
        correlationId: 'corr-1',
      });
      expect(client.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('anything else', () => {
    afterEach(() => jest.restoreAllMocks());

    it.each([
      ['an unexpected error', new Error('connect ECONNREFUSED postgres://bge:secret@db:5432')],
      ['a WsException with a message AuthGuard never throws', new WsException('meaningful only to its thrower')],
    ])('answers %s with a generic 500, and logs it', async (_, exception) => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { client, host } = frame('search:start', { correlationId: 'corr-1', query: 'Gloomhaven' });

      await filter.catch(exception, host);

      expect(client.emit).toHaveBeenCalledTimes(1);
      expect(client.emit).toHaveBeenCalledWith(WsErrorEvents.Exception, {
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal server error',
        pattern: 'search:start',
        correlationId: 'corr-1',
      });
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('search:start'), exception);
    });
  });
});

/**
 * A frame as the filter sees it: the socket it came from, the pattern it was
 * sent on, and its raw payload.
 */
function frame(pattern: string, data: unknown) {
  const client = { emit: jest.fn(), disconnect: jest.fn() };
  const host = {
    switchToWs: () => ({ getClient: () => client, getPattern: () => pattern, getData: () => data }),
  } as unknown as ArgumentsHost;

  return { client, host };
}

/** The exception a real `ValidationPipe` throws for `payload`. */
function validationFailure(payload: object): Promise<BadRequestException> {
  return new ValidationPipe().transform(payload, { type: 'body', metatype: SearchStartDto }).then(
    () => {
      throw new Error('expected the payload to fail validation');
    },
    (error: BadRequestException) => error,
  );
}
