import type { Actor, AuditContextService } from '@bge/actor-context';
import { FALLBACK_LOCALE } from '@bge/i18n';
import { CACHE_RESPONSE_KEY, CacheResponse } from '@bge/shared';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserAwareCacheInterceptor } from './user-aware-cache.interceptor';

// A controller with one route that opts in and one that doesn't. The marker
// is real metadata, read the way the interceptor reads it in the app.
class HandlerHost {
  @CacheResponse()
  cached() {
    return undefined;
  }

  uncached() {
    return undefined;
  }
}

const httpContext = (method: string, url: string, handler = HandlerHost.prototype.cached): ExecutionContext => {
  const request = { method, url };

  return {
    getHandler: () => handler,
    getClass: () => HandlerHost,
    getType: () => 'http',
    getArgByIndex: () => request,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
};

describe('UserAwareCacheInterceptor', () => {
  let interceptor: UserAwareCacheInterceptor;
  let reflector: Reflector;
  // What `HttpActorMiddleware` and `LocaleResolutionMiddleware` resolved for
  // the request under test.
  let actor: Actor | null;
  let locale: string | null;

  const user = (userId: string): Actor => ({ kind: 'user', userId });

  const trackBy = (ctx: ExecutionContext) =>
    (interceptor as unknown as { trackBy(context: ExecutionContext): string | undefined }).trackBy(ctx);

  beforeEach(() => {
    reflector = new Reflector();
    actor = null;
    locale = 'en';
    const auditContext = { getActor: () => actor, getLocale: () => locale } as Pick<
      AuditContextService,
      'getActor' | 'getLocale'
    >;
    // (cacheManager, reflector, auditContext) — the cache manager is not
    // touched by trackBy, so a stub suffices, and the audit context answers
    // `actor` and `locale`. The http adapter host is a property injection;
    // stub the two accessors the stock trackBy uses.
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
    actor = user('user-1');

    expect(trackBy(httpContext('GET', '/api/foo'))).toBe('user:user-1:en:/api/foo');
  });

  it('gives distinct users distinct keys for the same URL', () => {
    actor = user('user-1');
    const a = trackBy(httpContext('GET', '/api/foo'));
    actor = user('user-2');
    const b = trackBy(httpContext('GET', '/api/foo'));

    expect(a).not.toBe(b);
  });

  it("namespaces an anonymous guest's key by its own user id", () => {
    actor = { kind: 'anonymous', userId: 'guest-1' };

    expect(trackBy(httpContext('GET', '/api/foo'))).toBe('user:guest-1:en:/api/foo');
  });

  // #529: a key's ability is narrower than its owner's, so a body one of them
  // was allowed to read must not be served to the other.
  it("namespaces an API key's key by the key, apart from its owner's", () => {
    actor = { kind: 'apiKey', apiKeyId: 'key-1', userId: 'user-1' };
    const viaKey = trackBy(httpContext('GET', '/api/foo'));
    actor = user('user-1');
    const viaSession = trackBy(httpContext('GET', '/api/foo'));

    expect(viaKey).toBe('apikey:key-1:en:/api/foo');
    expect(viaKey).not.toBe(viaSession);
  });

  it('gives two keys of one owner distinct keys', () => {
    actor = { kind: 'apiKey', apiKeyId: 'key-1', userId: 'user-1' };
    const first = trackBy(httpContext('GET', '/api/foo'));
    actor = { kind: 'apiKey', apiKeyId: 'key-2', userId: 'user-1' };
    const second = trackBy(httpContext('GET', '/api/foo'));

    expect(first).not.toBe(second);
  });

  it('uses a shared anon namespace for unauthenticated requests', () => {
    expect(trackBy(httpContext('GET', '/api/languages'))).toBe('anon:en:/api/languages');
  });

  it.each<Actor>([
    { kind: 'system', reason: 'test' },
    { kind: 'external', system: 'test', identifier: 'caller-1' },
  ])('does not cache for a $kind actor, which no HTTP request resolves to', (other) => {
    actor = other;

    expect(trackBy(httpContext('GET', '/api/foo'))).toBeUndefined();
  });

  // #358: a body rendered in one language must not be served to a request
  // resolved to another, which a key without the locale would do.
  it('gives the same user distinct keys for the same URL in different locales', () => {
    actor = user('user-1');
    const english = trackBy(httpContext('GET', '/api/foo'));
    locale = 'fr';
    const french = trackBy(httpContext('GET', '/api/foo'));

    expect(french).toBe('user:user-1:fr:/api/foo');
    expect(french).not.toBe(english);
  });

  it('keeps anonymous requests in different locales apart', () => {
    locale = 'fr';

    expect(trackBy(httpContext('GET', '/api/languages'))).toBe('anon:fr:/api/languages');
  });

  it('keys an unresolved locale as the fallback locale, which is what the body renders in', () => {
    actor = user('user-1');
    locale = null;

    expect(trackBy(httpContext('GET', '/api/foo'))).toBe(`user:user-1:${FALLBACK_LOCALE}:/api/foo`);
  });

  it('does not cache non-GET requests (stock behavior preserved)', () => {
    actor = user('user-1');

    expect(trackBy(httpContext('POST', '/api/game-collections'))).toBeUndefined();
  });

  // #530: a hit skips the service's row checks, so a route is cached only
  // when it says so.
  it('does not cache a route that has not opted in', () => {
    actor = user('user-1');

    expect(trackBy(httpContext('GET', '/api/game-collections', HandlerHost.prototype.uncached))).toBeUndefined();
  });

  it('does not cache an anonymous request to a route that has not opted in', () => {
    expect(trackBy(httpContext('GET', '/api/foo', HandlerHost.prototype.uncached))).toBeUndefined();
  });

  it("ignores the marker on a controller, so a GET added to it later isn't cached", () => {
    class MarkedHost {
      uncached() {
        return undefined;
      }
    }
    Reflect.defineMetadata(CACHE_RESPONSE_KEY, true, MarkedHost);
    actor = user('user-1');

    const context = {
      ...httpContext('GET', '/api/foo', MarkedHost.prototype.uncached),
      getClass: () => MarkedHost,
    } as ExecutionContext;

    expect(trackBy(context)).toBeUndefined();
  });
});
