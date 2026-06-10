import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { Observable } from 'rxjs';
import { AuditContextInternalService, type ActorContextInit } from './audit-context-internal.service';

/**
 * Sanctioned API for entering a CLS scope from system code paths — health
 * pings, scheduled tasks, bootstrap discovery, periodic cleanup. Mints a
 * `system` actor with a caller-supplied `reason` describing the purpose,
 * a fresh correlation ID, and `source: 'system'`.
 *
 * Why this exists: the outbound gRPC actor-metadata interceptor and the
 * inbound `GrpcInternalActorInterceptor` are deliberately strict — they
 * refuse traffic without a real actor in CLS. That's correct for
 * application code (every HTTP-originated path should carry an actor
 * end-to-end), but service-level code that legitimately has no upstream
 * user needs a way to declare itself.
 *
 * Falling back to a synthesized actor in the outbound interceptor would
 * silently mask actual bugs (forgotten `await`, fire-and-forget patterns,
 * lost CLS scope across async boundaries) as "system" traffic and could
 * escalate privileges. This scope makes the system-origin explicit and
 * named at the call site, so the audit log records exactly which system
 * task initiated each call.
 *
 * Security: only mints `system` actors. Cannot be used to forge `user`,
 * `apiKey`, or other actor variants. The eslint restriction on
 * `AuditContextInternalService` continues to limit who can populate
 * those — entry-point interceptors and worker bases.
 *
 * Usage:
 *
 * ```ts
 * // Sync or async work:
 * await this.systemActorScope.run('cleanup-stale-sessions', () =>
 *   this.sessionService.purgeExpired(),
 * );
 *
 * // Observable-returning work (gRPC calls, Subjects, etc.):
 * this.systemActorScope.runObservable('coordinator-ping', () =>
 *   this.coordinator.ping(),
 * ).subscribe();
 * ```
 */
@Injectable()
export class SystemActorScope {
  constructor(private readonly auditContext: AuditContextInternalService) {}

  /**
   * Enters a CLS scope with a `system` actor and runs `fn` inside it.
   * Sync return when `fn` is sync; Promise when `fn` returns a Promise
   * (CLS via nestjs-cls propagates through promise chains via
   * AsyncLocalStorage, so awaits inside `fn` continue to see the actor).
   *
   * `reason` is recorded on the actor and surfaces in the audit log; pick
   * a stable, kebab-case identifier of the system task (`'coordinator-ping'`,
   * `'expired-session-purge'`, `'gateway-config-reload'`).
   */
  run<T>(reason: string, fn: () => T): T {
    return this.auditContext.runWith(this.buildInit(reason), fn);
  }

  /**
   * Wraps an Observable-returning factory so that subscription happens
   * inside a CLS scope.
   *
   * Why a factory and not the Observable directly: Observables are cold by
   * default — work doesn't begin until subscribe. If callers passed
   * `this.systemActorScope.runObservable('reason', someObservable)`, the
   * underlying call would have been issued before this method was even
   * invoked (e.g. inside `mergeMap`'s argument evaluation). The factory
   * defers construction of the inner Observable to subscribe time, where
   * the CLS scope is active.
   *
   * Each subscription enters its own fresh scope (new correlation ID).
   * Re-subscribing the returned Observable is therefore safe and does the
   * right thing — useful with `retry`, `repeat`, RxJS test schedulers, etc.
   */
  runObservable<T>(reason: string, fn: () => Observable<T>): Observable<T> {
    return new Observable<T>((subscriber) =>
      this.auditContext.runWith(this.buildInit(reason), () => fn().subscribe(subscriber)),
    );
  }

  private buildInit(reason: string): ActorContextInit {
    return {
      actor: { kind: 'system', reason },
      correlationId: crypto.randomUUID(),
      source: 'system',
    };
  }
}
