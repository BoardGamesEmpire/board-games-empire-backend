import { AuditContextService, AuditExclude, Auditable, MutationEvent } from '@bge/actor-context';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UNATTRIBUTED_ACTOR } from '../constants/audit-log.constants';
import { redactSnapshot } from '../utils/audit-snapshot.util';
import { AuditLogService } from './audit-log.service';
import { AuditUnattributedNotifierService } from './audit-unattributed-notifier.service';

/**
 * The issue #57 Phase 2 audit listener. Runs in every process that emits
 * domain events (api, worker, gateway-worker, gateway-coordinator — the same
 * fan-out as `WebhookDispatcherService`) and persists one `AuditLog` row per
 * auditable `MutationEvent`.
 *
 * Registered via `onAny`, not `@OnEvent('**')`: the emitters run
 * `wildcard: false`, so a wildcard decorator would never fire — and `onAny`
 * hands us the event name, which `@OnEvent` handlers cannot access. This also
 * makes the listener immune to per-app emitter-config drift.
 *
 * Audit semantics are OPT-OUT: any `MutationEvent` subclass is persisted
 * unless decorated `@Auditable(false)`. A forgotten decorator fails toward an
 * extra row, never a silent gap.
 *
 * Actor / source / correlationId come from CLS at handle time (propagated
 * through EventEmitter2 by AsyncLocalStorage — spec-verified in
 * `event-emitter-propagation.spec.ts`). An emission with no populated scope
 * is persisted under the unattributed fallback actor and raises a deduped
 * admin notification: the row is a label, never an authorization input.
 *
 * The handler never throws into the emitter — an audit failure must not
 * break the domain operation that produced the event.
 */
@Injectable()
export class AuditPersistenceListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditPersistenceListener.name);

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly reflector: Reflector,
    private readonly auditContext: AuditContextService,
    private readonly auditLog: AuditLogService,
    private readonly notifier: AuditUnattributedNotifierService,
  ) {}

  onModuleInit(): void {
    this.emitter.onAny(this.anyListener);
  }

  onModuleDestroy(): void {
    this.emitter.offAny(this.anyListener);
  }

  // Arrow property so `this` is bound for on/offAny registration.
  private readonly anyListener = (event: string | string[], payload: unknown): void => {
    const name = Array.isArray(event) ? event.join('.') : event;
    void this.handle(name, payload);
  };

  private async handle(eventName: string, payload: unknown): Promise<void> {
    if (!(payload instanceof MutationEvent)) {
      return;
    }

    if (this.reflector.get(Auditable, payload.constructor) === false) {
      return;
    }

    try {
      await this.persist(eventName, payload);
    } catch (err) {
      this.logger.error(
        `Audit persistence failed for "${eventName}" (${payload.subject} ${payload.subjectId}): ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  private async persist(eventName: string, event: MutationEvent): Promise<void> {
    const clsActor = this.auditContext.getActor();
    const source = this.auditContext.getSource();
    const denylist = this.reflector.get(AuditExclude, event.constructor) ?? [];

    await this.auditLog.record({
      event: eventName,
      actor: clsActor ?? UNATTRIBUTED_ACTOR,
      action: event.action,
      subject: event.subject,
      subjectId: event.subjectId,
      source,
      correlationId: this.auditContext.getCorrelationId(),
      before: redactSnapshot(event.before as Record<string, unknown> | null, denylist),
      after: redactSnapshot(event.after as Record<string, unknown> | null, denylist),
      initiatedAt: event.initiatedAt,
      occurredAt: event.occurredAt,
    });

    if (!clsActor) {
      // After the row is safely persisted; the notifier never throws.
      await this.notifier.notify(eventName, event.subject, source);
    }
  }
}
