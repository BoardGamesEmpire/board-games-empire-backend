import { Reflector } from '@nestjs/core';

/**
 * Marks an event class as auditable. The Phase 2 audit listener reads this
 * via an injected `Reflector` and filters events before persisting.
 *
 * Default is `true` when no argument is passed; use `@Auditable(false)` to
 * explicitly opt out for noisy domain events that share the `MutationEvent`
 * base class.
 *
 * @example
 *   @Auditable()
 *   export class NominationCreatedEvent extends MutationEvent<Nomination> {}
 *
 *   @Auditable(false)
 *   export class GameImportProgressEvent extends MutationEvent<ImportProgress> {}
 *
 * Reading the value:
 *   constructor(private readonly reflector: Reflector) {}
 *   // ...
 *   const isAudit = this.reflector.get(Auditable, event.constructor) === true;
 */
export const Auditable = Reflector.createDecorator<boolean, boolean>({
  transform: (value) => value ?? true,
});

/**
 * Marks fields on the payload type that must be stripped from `before` /
 * `after` snapshots before audit persistence. Applied at the event class
 * level; the Phase 2 audit listener consumes the list when diffing.
 *
 * No generic constraint on the field names — TypeScript can't infer the
 * payload type from `Reflector.createDecorator`. Use `satisfies` at the call
 * site if you want compile-time field-name checking:
 *
 * @example
 *   @Auditable()
 *   @AuditExclude(
 *     ['passwordHash', 'twoFactorSecret']
 *       satisfies readonly (keyof UserCreatedPayload & string)[],
 *   )
 *   export class UserCreatedEvent extends MutationEvent<UserCreatedPayload> {}
 *
 * Reading the denylist:
 *   const denylist = this.reflector.get(AuditExclude, event.constructor) ?? [];
 */
export const AuditExclude = Reflector.createDecorator<readonly string[]>();

/**
 * Base class for mutation events. Concrete events provide a discriminator
 * (e.g. `static readonly eventName`) and the payload `T` shape.
 *
 * `before` is `null` on create, `after` is `null` on delete. For updates both
 * are populated with the changed subset (Phase 2 will diff at persist time
 * against the `@AuditExclude` denylist).
 *
 * ## Timing fields
 *
 * Both timestamps are *local* to the step that produced this event — they
 * do NOT propagate from outer scopes. This keeps per-step duration
 * (`occurredAt - initiatedAt`) computable from a single audit row, and
 * makes total-chain duration derivable from the outermost row in a
 * correlation chain (since outer scopes start first and unwind last).
 *
 * - `initiatedAt`: supplied by the emitter, captured at the start of the
 *   step's unit of work. Phase 1 just locks the field shape; Phase 2's
 *   emit-site migration will introduce a scoping helper or CLS slot to
 *   make capture ergonomic. For now, callers pass it explicitly.
 *
 * - `occurredAt`: set by the constructor at the moment the event is
 *   constructed (i.e. the step's mutation completed and is about to be
 *   emitted).
 *
 * The DB row's own `createdAt` (Phase 2) reflects audit-listener insertion
 * time and exists for pipeline debugging, not UI sort. UIs sort by
 * `occurredAt`.
 *
 * ## What is NOT on the event
 *
 * Actor / source / correlationId are read from CLS at handle time by the
 * Phase 2 audit listener (nestjs-cls propagates context through
 * EventEmitter2 listeners). Keeping them off the payload prevents drift
 * and avoids forging.
 */
export abstract class MutationEvent<T = unknown> {
  public readonly initiatedAt: Date;
  public readonly occurredAt: Date;

  constructor(
    public readonly before: Readonly<Partial<T>> | null,
    public readonly after: Readonly<Partial<T>> | null,
    initiatedAt: Date,
  ) {
    this.initiatedAt = initiatedAt;
    this.occurredAt = new Date();
  }
}
