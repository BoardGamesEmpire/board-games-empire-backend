import { ClsServiceManager } from 'nestjs-cls';
import type { Actor, EventSource } from '../types';
import { ACTOR_CLS_KEY, CORRELATION_ID_CLS_KEY, SOURCE_CLS_KEY } from './audit-context.service';

/**
 * Read-only snapshot of the current actor context, returned by
 * {@link getActorSnapshotFromCls}. Structurally compatible with
 * `@bge/otel`'s `ActorSpanContext` so the function can be passed
 * directly as an `ActorContextProvider` without any adapter.
 *
 * `source` is included for parity with the CLS shape; consumers that
 * don't care about it (e.g. the OTel span processor) simply ignore it.
 */
export interface ActorContextSnapshot {
  actor?: Actor;
  correlationId?: string;
  source?: EventSource;
}

const EMPTY_SNAPSHOT: ActorContextSnapshot = Object.freeze({});

/**
 * Static, non-DI reader for the current actor context.
 *
 * Complements {@link AuditContextService} for consumers that cannot
 * receive DI — most notably the `ActorSpanProcessor` in `@bge/otel`,
 * which is constructed at OTel SDK init time, BEFORE `NestFactory.create`
 * runs and before any provider is instantiated.
 *
 * Uses {@link ClsServiceManager.getClsService} to reach the singleton
 * `ClsService` outside DI. When CLS is not active (pre-bootstrap, in a
 * job processed before the BullMQ worker enters its scope, etc.) returns
 * an empty snapshot rather than throwing — tracing must continue to work
 * without an actor.
 *
 * This helper is the ONLY sanctioned way for non-DI code to read the
 * actor context. Plugin code, application services, and listeners should
 * continue to inject {@link AuditContextService}.
 */
export const getActorSnapshotFromCls = (): ActorContextSnapshot => {
  try {
    const cls = ClsServiceManager.getClsService();
    if (!cls.isActive()) {
      return EMPTY_SNAPSHOT;
    }
    return {
      actor: cls.get<Actor | undefined>(ACTOR_CLS_KEY),
      correlationId: cls.get<string | undefined>(CORRELATION_ID_CLS_KEY),
      source: cls.get<EventSource | undefined>(SOURCE_CLS_KEY),
    };
  } catch {
    // CLS not yet initialized, or ClsServiceManager itself unavailable.
    // Both are valid pre-bootstrap states; do not let observability
    // bootstrap problems break the host application.
    return EMPTY_SNAPSHOT;
  }
};
