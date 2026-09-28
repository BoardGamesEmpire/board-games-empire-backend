import type { AuditContextService } from '@bge/actor-context';
import { SearchStartDto } from '@bge/game-search';
import { FALLBACK_LOCALE, I18N_CATALOG_DIR, i18nValidationMessage, t, type I18nTranslations } from '@bge/i18n';
import { WsErrorEvents } from '@bge/shared';
import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WsException } from '@nestjs/websockets';
import { IsString, IsUUID } from 'class-validator';
import { I18nModule, I18nService, I18nValidationException, I18nValidationPipe } from 'nestjs-i18n';
import { WsErrorFilter } from './ws-error.filter';

class MarkedDto {
  @IsString({ message: i18nValidationMessage('validation.isString') })
  query!: string;
}

/** A frame whose validator names no key, so its message is already copy. */
class BareDto {
  @IsUUID()
  correlationId!: string;
}

describe('WsErrorFilter', () => {
  let filter: WsErrorFilter;
  let i18n: I18nService<I18nTranslations>;
  let locale: string;
  const auditContext = { getLocale: () => locale } as unknown as AuditContextService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        I18nModule.forRoot({
          fallbackLanguage: FALLBACK_LOCALE,
          loaderOptions: { path: I18N_CATALOG_DIR, watch: false },
        }),
      ],
    }).compile();

    i18n = moduleRef.get(I18nService);
    filter = new WsErrorFilter(i18n, auditContext);
  });

  beforeEach(() => {
    locale = FALLBACK_LOCALE;
  });

  describe('translation', () => {
    afterEach(() => jest.restoreAllMocks());

    it("sends an I18nValidationPipe failure's own messages, translated in the frame's locale, rather than its status text", async () => {
      locale = 'fr';
      const translate = jest.spyOn(i18n, 'translate');
      const payload = { correlationId: 'corr-1', query: 42 };
      const { client, host } = hostFor('search:start', payload);

      await filter.catch(await failureOf(new I18nValidationPipe(), MarkedDto, payload), host);

      expect(translate).toHaveBeenCalledWith('validation.isString', expect.objectContaining({ lang: 'fr' }));
      expect(client.emit).toHaveBeenCalledWith(WsErrorEvents.Exception, {
        statusCode: 400,
        error: 'Bad Request',
        message: ['query must be a string'],
        pattern: 'search:start',
        correlationId: 'corr-1',
      });
    });

    it("translates a marker body in the frame's locale", async () => {
      locale = 'fr';
      const translate = jest.spyOn(i18n, 'translate');
      const { client, host } = hostFor('search:start', { correlationId: 'corr-1' });

      await filter.catch(new ForbiddenException(t('common.forbidden.action')), host);

      expect(translate).toHaveBeenCalledWith('common.forbidden.action', expect.objectContaining({ lang: 'fr' }));
      expect(client.emit).toHaveBeenCalledWith(WsErrorEvents.Exception, {
        statusCode: 403,
        error: 'Forbidden',
        message: 'You do not have permission to perform this action.',
        pattern: 'search:start',
        correlationId: 'corr-1',
      });
    });

    it("keeps a structured body's own error label and fields, as the HTTP body does", async () => {
      const { client, host } = hostFor('search:start', { correlationId: 'corr-1' });
      const exceeded = new HttpException(
        {
          statusCode: 402,
          error: 'Quota Exceeded',
          message: t('errors.quota.exceeded', { resource: 'storage_bytes', scope: 'User' }),
          resource: 'storage_bytes',
          scope: 'User',
          limit: 5,
        },
        402,
      );

      await filter.catch(exceeded, host);

      expect(client.emit).toHaveBeenCalledWith(WsErrorEvents.Exception, {
        statusCode: 402,
        error: 'Quota Exceeded',
        message: 'Quota for "storage_bytes" exceeded at User scope',
        resource: 'storage_bytes',
        scope: 'User',
        limit: 5,
        pattern: 'search:start',
        correlationId: 'corr-1',
      });
    });

    it("still answers, with the exception's status, when its copy cannot be translated, and logs why", async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const malformed = new Error('cannot switch from implicit to explicit numbering');
      jest.spyOn(i18n, 'translate').mockImplementation(() => {
        throw malformed;
      });
      const { client, host } = hostFor('search:start', { correlationId: 'corr-1' });

      await filter.catch(new UnauthorizedException(t('errors.auth.session_invalid')), host);

      // What the frame was answered with before its copy was translated.
      expect(client.emit).toHaveBeenCalledWith(WsErrorEvents.AuthError, {
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Unauthorized Exception',
        pattern: 'search:start',
        correlationId: 'corr-1',
      });
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('search:start'), malformed);
    });

    it('takes the status and the frame from the exception and the frame, not from body fields of the same name', async () => {
      const { client, host } = hostFor('search:start', { query: 'Gloomhaven' });
      const body = { statusCode: 999, message: 'refused', pattern: 'elsewhere', correlationId: 'not-this-frame' };

      await filter.catch(new HttpException(body, 409), host);

      expect(client.emit).toHaveBeenCalledWith(WsErrorEvents.Exception, {
        statusCode: 409,
        error: 'Conflict',
        message: 'refused',
        pattern: 'search:start',
      });
    });
  });

  it('sends a validation failure to the socket on `exception`, shaped like the HTTP error body', async () => {
    const payload = { correlationId: 'not-a-uuid', query: 'Gloomhaven' };
    const { client, host } = hostFor('search:start', payload);

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

  // What a plain `ValidationPipe` throws, as a handler throwing
  // `BadRequestException([…])` would: a message list that is already copy.
  it("sends a plain validation failure's messages as they are", async () => {
    const payload = { correlationId: 'not-a-uuid' };
    const { client, host } = hostFor('search:cancel', payload);

    await filter.catch(await failureOf(new ValidationPipe(), BareDto, payload), host);

    expect(client.emit).toHaveBeenCalledWith(WsErrorEvents.Exception, {
      statusCode: 400,
      error: 'Bad Request',
      message: ['correlationId must be a UUID'],
      pattern: 'search:cancel',
      correlationId: 'not-a-uuid',
    });
  });

  it('keeps the status of any HTTP exception, including one whose body is a plain string', async () => {
    const { client, host } = hostFor('search:start', { correlationId: 'corr-1' });

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
    const { client, host } = hostFor('search:start', payload);

    await filter.catch(new ConflictException('refused'), host);

    const [, sent] = client.emit.mock.calls[0];
    expect(sent).not.toHaveProperty('correlationId');
  });

  it('ends the connection for an HTTP 401 as for a missing session: `auth:error`, then a disconnect', async () => {
    const { client, host } = hostFor('search:start', { correlationId: 'corr-1' });

    await filter.catch(new UnauthorizedException('Session revoked'), host);

    expect(client.emit).toHaveBeenCalledTimes(1);
    expect(client.emit).toHaveBeenCalledWith(WsErrorEvents.AuthError, {
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Session revoked',
      pattern: 'search:start',
      correlationId: 'corr-1',
    });
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  describe('the WsExceptions AuthGuard throws', () => {
    it('answers a frame whose session is gone on `auth:error`, then disconnects', async () => {
      const { client, host } = hostFor('search:start', { correlationId: 'corr-1' });

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
      const { client, host } = hostFor('search:start', { correlationId: 'corr-1' });

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
      const { client, host } = hostFor('search:start', { correlationId: 'corr-1', query: 'Gloomhaven' });

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
 * The exception host for one frame: the socket it came from, the pattern it
 * was sent on, and its raw payload.
 */
function hostFor(pattern: string, data: unknown) {
  const client = { emit: jest.fn(), disconnect: jest.fn() };
  const host = {
    switchToWs: () => ({ getClient: () => client, getPattern: () => pattern, getData: () => data }),
  } as unknown as ArgumentsHost;

  return { client, host };
}

/**
 * What an `I18nValidationPipe` throws validating `payload` as `SearchStartDto`.
 * Its options are the defaults, not the gateway's: those decide which failures
 * a frame produces, not what this filter does with one, and the gateway's own
 * pipe runs in authenticated.gateway.integration.spec.ts. `SearchStartDto`'s
 * messages are catalog markers (#503), so a plain `ValidationPipe` would hand
 * the filter those rather than copy.
 */
function validationFailure(payload: object): Promise<I18nValidationException> {
  return failureOf(new I18nValidationPipe(), SearchStartDto, payload);
}

/** The exception `pipe` throws validating `payload` as `metatype`. */
function failureOf<E extends BadRequestException | I18nValidationException>(
  pipe: ValidationPipe,
  metatype: new () => object,
  payload: object,
): Promise<E> {
  return pipe.transform(payload, { type: 'body', metatype }).then(
    () => {
      throw new Error('expected the payload to fail validation');
    },
    (error: E) => error,
  );
}
