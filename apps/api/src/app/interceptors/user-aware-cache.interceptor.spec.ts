import type { AuditContextService } from '@bge/actor-context';
import { FALLBACK_LOCALE } from '@bge/i18n';
import { NO_CACHE_KEY } from '@bge/shared';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserAwareCacheInterceptor } from './user-aware-cache.interceptor';

// Real function/class targets — Reflect.getMetadata rejects primitives.
const handlerFn = () => undefined;
class HandlerHost {}

const httpContext = (method: string, url: string, userId?: string): ExecutionContext => {
  const request = { method, url, ...(userId ? { user: { id: userId } } : {}) };

  return {
    getHandler: () => handlerFn,
    getClass: () => HandlerHost,
    getType: () => 'http',
    getArgByIndex: () => request,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
};

describe('UserAwareCacheInterceptor', () => {
  let interceptor: UserAwareCacheInterceptor;
  let reflector: Reflector;
  // What `LocaleResolutionMiddleware` resolved for the request under test.
  let locale: string | null;

  const trackBy = (ctx: ExecutionContext) =>
    (interceptor as unknown as { trackBy(context: ExecutionContext): string | undefined }).trackBy(ctx);

  beforeEach(() => {
    reflector = new Reflector();
    locale = 'en';
    const auditContext = { getLocale: () => locale } as Pick<AuditContextService, 'getLocale'>;
    // (cacheManager, reflector, auditContext) — the cache manager is not
    // touched by trackBy, so a stub suffices, and the audit context answers
    // `locale`. The http adapter host is a property injection; stub the two
    // accessors the stock trackBy uses.
    interceptor = new UserAwareCacheInterceptor({}, reflector, auditContext as AuditContextService);
    Object.assign(interceptor, {
      httpAdapterHost: {
        httpAdapter: {
          getRequestMethod: (request: { method: string }) => request.method,
          getRequestUrl: (request: { url: string }) => request.url,
        },
      },
    });
  });

  it('namespaces the cache key by the authenticated user and the request locale', () => {
    expect(trackBy(httpContext('GET', '/api/game-collections', 'user-1'))).toBe('user:user-1:en:/api/game-collections');
  });

  it('gives distinct users distinct keys for the same URL', () => {
    const a = trackBy(httpContext('GET', '/api/foo', 'user-1'));
    const b = trackBy(httpContext('GET', '/api/foo', 'user-2'));
    expect(a).not.toBe(b);
  });

  it('uses a shared anon namespace for unauthenticated requests', () => {
    expect(trackBy(httpContext('GET', '/api/languages'))).toBe('user:anon:en:/api/languages');
  });

  // #358: a body rendered in one language must not be served to a request
  // resolved to another, which a key without the locale would do.
  it('gives the same user distinct keys for the same URL in different locales', () => {
    const english = trackBy(httpContext('GET', '/api/foo', 'user-1'));
    locale = 'fr';
    const french = trackBy(httpContext('GET', '/api/foo', 'user-1'));

    expect(french).toBe('user:user-1:fr:/api/foo');
    expect(french).not.toBe(english);
  });

  it('keeps anonymous requests in different locales apart', () => {
    locale = 'fr';

    expect(trackBy(httpContext('GET', '/api/languages'))).toBe('user:anon:fr:/api/languages');
  });

  it('keys an unresolved locale as the fallback locale, which is what the body renders in', () => {
    locale = null;

    expect(trackBy(httpContext('GET', '/api/foo', 'user-1'))).toBe(`user:user-1:${FALLBACK_LOCALE}:/api/foo`);
  });

  it('does not cache non-GET requests (stock behavior preserved)', () => {
    expect(trackBy(httpContext('POST', '/api/game-collections', 'user-1'))).toBeUndefined();
  });

  it('skips caching entirely for @NoCache() routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => key === NO_CACHE_KEY);

    expect(trackBy(httpContext('GET', '/api/game-collections', 'user-1'))).toBeUndefined();
  });
});
