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
        throw new ForbiddenException(`Actor kind '${actor.kind}' cannot perform user-attributed writes.`);
    }
  }

  /**
   * Like `getActor`, but throws if no actor is set. Use at points where the
   * absence of an actor would be a programmer error (e.g. inside a controller
   * route that has gone through the auth interceptor).
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
}
