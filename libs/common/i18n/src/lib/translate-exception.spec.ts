/* eslint-disable bge/no-uncoded-exception-body -- these cases hand the renderer a coded body no producer may build, to pin that it completes any body into the envelope (#1260) */
import { t } from '@bge/i18n-core';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { translateException } from './translate-exception';

describe('translateException', () => {
  let translate: jest.Mock;
  let i18n: { translate: jest.Mock };
  const auditContext = { getLocale: () => 'en' } as never;

  beforeEach(() => {
    translate = jest.fn((key: string) => `t:${key}`);
    i18n = { translate };
  });

  it('translates a whole-body marker into the standard { statusCode, message, error } shape', () => {
    const rebuilt = translateException(
      new NotFoundException(t('errors.language.not_found', { id: '42' })),
      i18n as never,
      auditContext,
    );

    expect(translate).toHaveBeenCalledWith('errors.language.not_found', { lang: 'en', args: { id: '42' } });
    expect(rebuilt.getStatus()).toBe(404);
    expect(rebuilt.getResponse()).toEqual({
      statusCode: 404,
      message: 't:errors.language.not_found',
      error: 'Not Found',
    });
  });

  it("translates only the `message` field of a structured body, keeping sibling fields and status, under the status's reason phrase (#1260)", () => {
    // Shape mirrors the old QuotaExceededException: machine-readable fields beside
    // a translatable message marker, under a custom `error` label. The label gives
    // way to the standard reason phrase, so every error names its status alike.
    const original = new HttpException(
      {
        statusCode: 402,
        error: 'Quota Exceeded',
        message: t('errors.quota.exceeded', { resource: 'storage_bytes', scope: 'User' }),
        resource: 'storage_bytes',
        scope: 'User',
        limit: '100',
        currentUsage: '100',
        attemptedAmount: '1',
      },
      402,
    );

    const rebuilt = translateException(original, i18n as never, auditContext);

    expect(translate).toHaveBeenCalledWith('errors.quota.exceeded', {
      lang: 'en',
      args: { resource: 'storage_bytes', scope: 'User' },
    });
    expect(rebuilt.getStatus()).toBe(402);
    // The message is rendered and every other field survives.
    expect(rebuilt.getResponse()).toEqual({
      statusCode: 402,
      error: 'Payment Required',
      message: 't:errors.quota.exceeded',
      resource: 'storage_bytes',
      scope: 'User',
      limit: '100',
      currentUsage: '100',
      attemptedAmount: '1',
    });
  });

  describe('copy that cannot render', () => {
    const malformed = new Error('cannot switch from implicit to explicit numbering');
    let logged: jest.SpyInstance;

    beforeEach(() => {
      translate.mockImplementation(() => {
        throw malformed;
      });
      logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => logged.mockRestore());

    it("renders a whole-body marker's key, and none of its args, with the exception's status, and logs why", () => {
      const rebuilt = translateException(
        new NotFoundException(t('errors.language.not_found', { id: '42' })),
        i18n as never,
        auditContext,
      );

      expect(rebuilt.getStatus()).toBe(404);
      expect(rebuilt.getResponse()).toEqual({
        statusCode: 404,
        message: 'errors.language.not_found',
        error: 'Not Found',
      });
      expect(logged).toHaveBeenCalledWith("Could not render 'errors.language.not_found' in 'en'", malformed.stack);
    });

    it("renders the key in a structured body's message and keeps every other field, as a full envelope (#1260)", () => {
      const original = new HttpException(
        {
          statusCode: 402,
          error: 'Quota Exceeded',
          message: t('errors.quota.exceeded', { resource: 'storage_bytes', scope: 'User' }),
          resource: 'storage_bytes',
          scope: 'User',
          limit: '100',
        },
        402,
      );

      const rebuilt = translateException(original, i18n as never, auditContext);

      expect(rebuilt.getStatus()).toBe(402);
      expect(rebuilt.getResponse()).toEqual({
        statusCode: 402,
        error: 'Payment Required',
        message: 'errors.quota.exceeded',
        resource: 'storage_bytes',
        scope: 'User',
        limit: '100',
      });
    });

    it("still sends a coded refusal's code, as a full envelope with the key as its message (#1260)", () => {
      const rebuilt = translateException(
        new ConflictException({ code: 'CATALOG_ENTRY_CHANGED', message: t('errors.permission_catalog.entry_changed') }),
        i18n as never,
        auditContext,
      );

      expect(rebuilt.getResponse()).toEqual({
        statusCode: 409,
        error: 'Conflict',
        message: 'errors.permission_catalog.entry_changed',
        code: 'CATALOG_ENTRY_CHANGED',
      });
    });

    // A throw need not be an Error; with no stack to log, the thrown value is.
    it('logs a thrown non-Error as it was thrown', () => {
      translate.mockImplementation(() => {
        throw 'unterminated placeholder';
      });

      const rebuilt = translateException(
        new NotFoundException(t('errors.language.not_found')),
        i18n as never,
        auditContext,
      );

      expect(rebuilt.getResponse()).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: 'errors.language.not_found',
      });
      expect(logged).toHaveBeenCalledWith(
        "Could not render 'errors.language.not_found' in 'en'",
        'unterminated placeholder',
      );
    });
  });

  it('preserves the original cause across the re-issue', () => {
    const cause = new Error('raw driver error');
    const original = new HttpException(t('errors.storage.unavailable'), 503, { cause });

    const rebuilt = translateException(original, i18n as never, auditContext);

    expect((rebuilt as unknown as { cause?: unknown }).cause).toBe(cause);
  });

  it('completes the envelope of a coded body whose message is a marker (#1260)', () => {
    const out = translateException(
      new ConflictException({ code: 'CATALOG_ENTRY_CHANGED', message: t('errors.permission_catalog.entry_changed') }),
      i18n as never,
      auditContext,
    );

    expect(out.getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 't:errors.permission_catalog.entry_changed',
      code: 'CATALOG_ENTRY_CHANGED',
    });
  });

  it('completes the envelope of a coded body whose message is a string (#1260)', () => {
    const out = translateException(
      new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'plain' }),
      i18n as never,
      auditContext,
    );

    expect(out.getResponse()).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'plain',
      code: 'UNAUTHORIZED',
    });
    expect(translate).not.toHaveBeenCalled();
  });

  it('gives a string body the envelope (#1260)', () => {
    const out = translateException(
      new HttpException('ThrottlerException: Too Many Requests', 429),
      i18n as never,
      auditContext,
    );

    expect(out.getResponse()).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'ThrottlerException: Too Many Requests',
    });
  });

  it("keeps a validation 400's string[] message (#1260)", () => {
    const out = translateException(new BadRequestException(['a', 'b']), i18n as never, auditContext);

    expect(out.getResponse()).toEqual({ statusCode: 400, error: 'Bad Request', message: ['a', 'b'] });
  });

  it('answers a plain Nest exception with the body it already had (#1260)', () => {
    const out = translateException(new NotFoundException('x'), i18n as never, auditContext);

    expect(out.getResponse()).toEqual({ statusCode: 404, error: 'Not Found', message: 'x' });
    expect(translate).not.toHaveBeenCalled();
  });

  it('renders a list of markers item by item, beside the strings in it (#1260)', () => {
    const out = translateException(
      new BadRequestException([t('errors.language.not_found', { id: '42' }), 'b']),
      i18n as never,
      auditContext,
    );

    expect(out.getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: ['t:errors.language.not_found', 'b'],
    });
  });

  it("names the status's reason phrase when an object body has no message, and logs nothing (#1260)", () => {
    const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const out = translateException(new ConflictException({ code: 'X' }), i18n as never, auditContext);

    expect(out.getResponse()).toEqual({ statusCode: 409, error: 'Conflict', message: 'Conflict', code: 'X' });
    expect(warned).not.toHaveBeenCalled();
    warned.mockRestore();
  });

  it("names the status's reason phrase for a message it cannot read, and logs that it dropped it (#1260)", () => {
    const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const out = translateException(new HttpException({ message: { nested: true } }, 400), i18n as never, auditContext);

    expect(out.getResponse()).toEqual({ statusCode: 400, error: 'Bad Request', message: 'Bad Request' });
    expect(warned).toHaveBeenCalledWith('A 400 body carried a message no client can read; sent its reason phrase');
    warned.mockRestore();
  });

  it("lets no body field contradict the response's status (#1260)", () => {
    const out = translateException(
      new HttpException({ statusCode: 200, error: 'Custom', message: 'm', code: 'X' }, 409),
      i18n as never,
      auditContext,
    );

    expect(out.getStatus()).toBe(409);
    expect(out.getResponse()).toEqual({ statusCode: 409, error: 'Conflict', message: 'm', code: 'X' });
  });

  it("keeps a plain exception's cause across the re-issue (#1260)", () => {
    const cause = new Error('raw driver error');

    const out = translateException(new NotFoundException('x', { cause }), i18n as never, auditContext);

    expect(out.cause).toBe(cause);
  });
});
