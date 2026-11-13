import type { AuditContextService } from '@bge/actor-context';
import { t } from '@bge/i18n-core';
import { type ArgumentsHost, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { I18nService } from 'nestjs-i18n';
import type { LocaleResolutionService } from './locale-resolution.service';
import { UnknownErrorFilter } from './unknown-error.filter';

const i18n = { translate: jest.fn((key: string) => `t:${key}`) };
const auditContext = { getLocale: () => 'en' } as unknown as AuditContextService;
const localeResolution = { resolveAcceptLanguage: () => 'en' } as unknown as LocaleResolutionService;

// A request a route matched, as every request a handler throws from is.
const hostOf = (type: string) =>
  ({
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => ({ route: { path: '/x' }, headers: {} }) }),
  }) as unknown as ArgumentsHost;

/** What the filter hands Nest's own rendering, which writes it to the response. */
function rendered(exception: unknown, type = 'http'): unknown {
  const passed = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
  new UnknownErrorFilter(i18n as unknown as I18nService, auditContext, localeResolution).catch(exception, hostOf(type));

  return passed.mock.calls[0][0];
}

describe('UnknownErrorFilter (#527)', () => {
  afterEach(() => jest.restoreAllMocks());

  it("leaves a host that isn't HTTP to Nest's own handling, untranslated", () => {
    const exception = new Error('x');

    expect(rendered(exception, 'rpc')).toBe(exception);
  });

  // Nest picks it only when no other filter matched, so it never sees one in
  // the api. Mounted on its own, it still answers in the envelope (#1260).
  it('renders an HttpException that reaches it, keeping its status', () => {
    const answer = rendered(new NotFoundException(t('errors.language.not_found', { id: '1' })));

    expect(answer).toBeInstanceOf(HttpException);
    expect((answer as HttpException).getStatus()).toBe(404);
    expect((answer as HttpException).getResponse()).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 't:errors.language.not_found',
    });
  });

  it.each([
    ['a non-numeric status', { statusCode: '413', message: 'too large', expose: true }],
    ['a status outside 4xx and 5xx', { statusCode: 302, message: 'moved', expose: true }],
    ['a message that is not text', { statusCode: 413, message: 42, expose: true }],
    // better-auth's APIError, which `AuthService` rethrows: a server-side
    // failure, not a request the client must fix (#527).
    [
      'a status but no http-errors `expose` flag',
      { name: 'APIError', status: 'UNAUTHORIZED', statusCode: 401, message: 'Unauthorized' },
    ],
  ])("answers an error carrying %s as an unknown error's 500 (#527)", (_, shape) => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const answer = rendered(Object.assign(Object.create(Error.prototype), shape));

    expect((answer as HttpException).getStatus()).toBe(500);
    expect((answer as HttpException).getResponse()).toMatchObject({ message: 't:errors.request.failed' });
  });

  it('keeps the error as the cause, for the logs', () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const error = new Error('x');

    expect((rendered(error) as HttpException).cause).toBe(error);
  });
});
