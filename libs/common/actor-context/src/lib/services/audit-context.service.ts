import { t } from '@bge/i18n-core';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Actor, EventSource } from '../types';

/**
 * CLS storage keys. Exported for tests + the internal populator only;
 * consumers should never read CLS directly.
 */
export const ACTOR_CLS_KEY = 'actor-context:actor' as const;
export const CORRELATION_ID_CLS_KEY = 'actor-context:correlationId' as const;
export const SOURCE_CLS_KEY = 'actor-context:source' as const;
export const LOCALE_CLS_KEY = 'actor-context:locale' as const;

/**
 * When the caller's session was signed in (the session's `createdAt`), set by
 * the HTTP actor middleware for a signed-in user only. It lives in its own CLS
 * slot rather than on `Actor` because `Actor` reaches audit rows and job
 * payloads, and a sign-in time belongs to neither (#1418). Consumers read it
 * only through {@link AuditContextService.getSessionSignedInAt}; the key stays
 * out of the lib's public barrel so no other code can read or write the slot.
 */
export const SESSION_SIGNED_IN_AT_CLS_KEY = 'actor-context:sessionSignedInAt' as const;

/**
 * CLS slot for the per-request resolved ability array. OWNED by the
 * permissions lib (`AbilityContextInternalService` is the only sanctioned
 * writer; reads go through `AbilityService`) — the key string alone lives
 * here because scope transitions must sever it: abilities are resolved FOR
 * an actor, so a scope that installs a new actor (`runWith`) must not
 * inherit the previous actor's set. This lib cannot import the permissions
 * lib to learn the key (the dependency points the other way).
 */
export const ABILITIES_CLS_KEY = 'permissions:abilities' as const;

/**
 * Public, read-only accessor for actor + correlation context. Consumers
 * (services, event emitters, listeners) inject this; they cannot set values.
 *
 * Population happens at entry-point interceptors (HTTP/gRPC/queue) via
 * `AuditContextInternalService`, which is not part of the public surface.
 *
 * Plugins are expected to consume only this class — they cannot forge an
 * actor because the internal setter is not exported from the lib's public
 * barrel.
 */
@Injectable()
export class AuditContextService {
  constructor(private readonly cls: ClsService) {}

  /**
   * Returns the current actor, or `null` if the request is unauthenticated
   * and no system actor was explicitly set.
   *
   * Phase 1: most consumers should treat `null` as "do not audit yet" rather
   * than throwing — Phase 2's listener will enforce the contract.
   */
  getActor(): Actor | null {
    return this.cls.get<Actor | undefined>(ACTOR_CLS_KEY) ?? null;
  }

  // AuditContextService (the actor reader, @bge/actor-context)
  getActingUserId(): string {
    const actor = this.getActor();
    if (!actor) {
      throw new Error('getActingUserId called with no actor in context');
    }

    switch (actor.kind) {
      case 'user':
      case 'anonymous':
      case 'apiKey':
        return actor.userId;
      default:
        // system | external | plugin — no backing user yet (polymorphic attribution deferred to #59)
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: actor.kind }));
    }
  }

  /**
   * Like `getActor`, but throws if no actor is set. Use at points where the
   * absence of an actor would be a programmer error (e.g. inside a controller
   * route, where `ActorAuthGuard` has refused any request without one).
   */
  getActorOrThrow(): Actor {
    const actor = this.getActor();
    if (!actor) {
      throw new Error('AuditContextService.getActorOrThrow called outside a populated CLS scope');
    }

    return actor;
  }

  getCorrelationId(): string | null {
    return this.cls.get<string | undefined>(CORRELATION_ID_CLS_KEY) ?? null;
  }

  getSource(): EventSource | null {
    return this.cls.get<EventSource | undefined>(SOURCE_CLS_KEY) ?? null;
  }

  /**
   * Resolved catalog locale for the current request/job (a `systemSupported`
   * `LanguageTag.tag`, e.g. `en`), or `null` when no entry seam has resolved
   * one — non-HTTP seams populate it in #146/#147. Callers rendering
   * translations should treat `null` as "use the fallback locale".
   */
  getLocale(): string | null {
    return this.cls.get<string | undefined>(LOCALE_CLS_KEY) ?? null;
  }

  /**
   * When the caller's session was signed in, so a route can require a recent
   * sign-in before an act such as giving an API key a Critical permission
   * (#1418). `null` for everything but a signed-in user over HTTP: an API key,
   * an anonymous user, no actor, any other source (a queue job included), and
   * a call outside any request or job scope. Both the actor and the source
   * are checked here, so a nested system or plugin scope never reads the
   * request's sign-in time.
   */
  getSessionSignedInAt(): Date | null {
    if (!this.cls.isActive()) {
      return null;
    }

    if (this.getSource() !== 'http' || this.getActor()?.kind !== 'user') {
      return null;
    }

    return this.cls.get<Date | undefined>(SESSION_SIGNED_IN_AT_CLS_KEY) ?? null;
  }
}
