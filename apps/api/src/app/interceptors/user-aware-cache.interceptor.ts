import { NO_CACHE_KEY } from '@bge/shared';
import { CacheInterceptor } from '@nestjs/cache-manager';
import { ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Response cache keyed per acting user.
 *
 * The stock {@link CacheInterceptor} tracks by request URL alone, so with
 * authenticated, user-scoped routes one user's cached response is served to
 * the next user who requests the same URL — a cross-user data leak. This
 * subclass namespaces the key by the authenticated user id (populated on the
 * request by the better-auth guard), with a shared `anon` namespace for
 * unauthenticated requests.
 *
 * Routes marked with `@NoCache()` are never cached — for user-scoped,
 * mutation-adjacent surfaces where a stale read within the cache TTL is a
 * correctness bug (e.g. offline-first clients that write then re-read).
 */
@Injectable()
export class UserAwareCacheInterceptor extends CacheInterceptor {
  protected override trackBy(context: ExecutionContext): string | undefined {
    const noCache = this.reflector.getAllAndOverride<boolean>(NO_CACHE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (noCache) {
      return undefined;
    }

    const key = super.trackBy(context);
    if (!key) {
      return undefined;
    }

    const request = context.switchToHttp().getRequest();
    return `user:${request?.user?.id ?? 'anon'}:${key}`;
  }
}
