import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Actor, EventSource } from '../types';
import { ACTOR_CLS_KEY, CORRELATION_ID_CLS_KEY, SOURCE_CLS_KEY } from './audit-context.service';

export interface ActorContextInit {
  readonly actor: Actor | null;
  readonly correlationId: string;
  readonly source: EventSource;
}

/**
 * Internal populator. NOT exported from the lib's public barrel.
 *
 * Only entry-point interceptors and worker bases (HTTP interceptor, gRPC
 * interceptor, BullMQ worker base) should inject this. Application code and
 * plugins must use {@link AuditContextService}.
 *
 * The split exists because the issue requires "Plugins have read-only access
 * to CLS actor; cannot forge."
 */
@Injectable()
export class AuditContextInternalService {
  constructor(private readonly cls: ClsService) {}

  /**
   * Runs `fn` inside a populated CLS scope. The new scope inherits any parent
   * CLS state via nestjs-cls' `runWith`.
   */
  runWith<T>(init: ActorContextInit, fn: () => T): T {
    const existingStore = this.cls.get() ?? {};
    const store = {
      ...existingStore,
      [ACTOR_CLS_KEY]: init.actor,
      [CORRELATION_ID_CLS_KEY]: init.correlationId,
      [SOURCE_CLS_KEY]: init.source,
    };

    return this.cls.runWith(store, fn);
  }

  /**
   * Populates the *current* CLS scope. Used by interceptors that have already
   * entered a CLS scope (via `ClsMiddleware` or `ClsInterceptor`) and just
   * need to fill values.
   *
   * Throws if called outside an active scope.
   */
  populate(init: ActorContextInit): void {
    if (!this.cls.isActive()) {
      throw new Error('AuditContextInternalService.populate called outside an active CLS scope');
    }

    this.cls.set(ACTOR_CLS_KEY, init.actor);
    this.cls.set(CORRELATION_ID_CLS_KEY, init.correlationId);
    this.cls.set(SOURCE_CLS_KEY, init.source);
  }
}
