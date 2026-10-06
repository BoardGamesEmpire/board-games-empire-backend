import { AuditContextService, type Actor } from '@bge/actor-context';
import { FALLBACK_LOCALE } from '@bge/i18n';
import { NO_CACHE_KEY } from '@bge/shared';
import { CACHE_MANAGER, CacheInterceptor } from '@nestjs/cache-manager';
import { ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * Response cache keyed per caller and request locale.
 *
 * The stock {@link CacheInterceptor} tracks by request URL alone, so with
 * authenticated, user-scoped routes one user's cached response is served to
 * the next user who requests the same URL — a cross-user data leak. This
 * subclass namespaces the key by the actor `HttpActorMiddleware` resolved,
 * with a shared `anon` namespace for unauthenticated requests.
 *
 * An API key gets a namespace of its own, apart from its owner's (#529). A
 * key is checked against its own scopes as well as its owner's roles, so it
 * may read less than its owner. A shared entry would serve the owner's body
 * to the key, or the key's narrower body to the owner.
 *
 * The locale is in the key too (#358). Bodies cached today carry translation
 * markers that `I18nResponseInterceptor` renders after a hit, so none of them
 * differ by locale — but a cached route whose service renders in the request
 * locale itself would otherwise replay one caller's language to the same
 * caller asking in another. An unresolved locale is keyed as
 * {@link FALLBACK_LOCALE}, the locale such a body renders in.
 *
 * Routes marked with `@NoCache()` are never cached — for user-scoped,
 * mutation-adjacent surfaces where a stale read within the cache TTL is a
 * correctness bug (e.g. offline-first clients that write then re-read).
 */
@Injectable()
export class UserAwareCacheInterceptor extends CacheInterceptor {
  constructor(
    @Inject(CACHE_MANAGER) cacheManager: unknown,
    reflector: Reflector,
    private readonly auditContext: AuditContextService,
  ) {
    super(cacheManager, reflector);
  }

  protected override trackBy(context: ExecutionContext): string | undefined {
    const noCache = this.reflector.getAllAndOverride<boolean>(NO_CACHE_KEY, [context.getHandler(), context.getClass()]);
    if (noCache) {
      return undefined;
    }

    const key = super.trackBy(context);
    if (!key) {
      return undefined;
    }

    const caller = callerNamespace(this.auditContext.getActor());
    if (!caller) {
      return undefined;
    }

    const locale = this.auditContext.getLocale() ?? FALLBACK_LOCALE;
    return `${caller}:${locale}:${key}`;
  }
}

/**
 * The cache namespace for a caller, or `undefined` for an actor that no HTTP
 * request resolves to, whose response is then not cached.
 */
function callerNamespace(actor: Actor | null): string | undefined {
  switch (actor?.kind) {
    case undefined:
      return 'anon';
    case 'apiKey':
      return `apikey:${actor.apiKeyId}`;
    case 'user':
    case 'anonymous':
      return `user:${actor.userId}`;
    default:
      return undefined;
  }
}
