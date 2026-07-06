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

  const trackBy = (ctx: ExecutionContext) =>
    (interceptor as unknown as { trackBy(context: ExecutionContext): string | undefined }).trackBy(ctx);

  beforeEach(() => {
    reflector = new Reflector();
    // CacheInterceptor(cacheManager, reflector) — the cache manager is not
    // touched by trackBy, so a stub suffices. The http adapter host is a
    // property injection; stub the two accessors the stock trackBy uses.
    interceptor = new UserAwareCacheInterceptor({}, reflector);
    Object.assign(interceptor, {
      httpAdapterHost: {
        httpAdapter: {
          getRequestMethod: (request: { method: string }) => request.method,
          getRequestUrl: (request: { url: string }) => request.url,
        },
      },
    });
  });

  it('namespaces the cache key by the authenticated user', () => {
    expect(trackBy(httpContext('GET', '/api/game-collections', 'user-1'))).toBe(
      'user:user-1:/api/game-collections',
    );
  });

  it('gives distinct users distinct keys for the same URL', () => {
    const a = trackBy(httpContext('GET', '/api/foo', 'user-1'));
    const b = trackBy(httpContext('GET', '/api/foo', 'user-2'));
    expect(a).not.toBe(b);
  });

  it('uses a shared anon namespace for unauthenticated requests', () => {
    expect(trackBy(httpContext('GET', '/api/languages'))).toBe('user:anon:/api/languages');
  });

  it('does not cache non-GET requests (stock behavior preserved)', () => {
    expect(trackBy(httpContext('POST', '/api/game-collections', 'user-1'))).toBeUndefined();
  });

  it('skips caching entirely for @NoCache() routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => key === NO_CACHE_KEY);

    expect(trackBy(httpContext('GET', '/api/game-collections', 'user-1'))).toBeUndefined();
  });
});
