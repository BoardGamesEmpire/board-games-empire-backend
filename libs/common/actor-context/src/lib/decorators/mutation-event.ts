import { Reflector } from '@nestjs/core';

/**
 * Opt-out marker for audit persistence. Every `MutationEvent` subclass is
 * auditable BY DEFAULT — a forgotten decorator must fail toward an extra
 * audit row, never toward a silent gap in the trail. Use `@Auditable(false)`
 * to exempt noisy domain events that share the `MutationEvent` base class;
 * the bare form `@Auditable()` is legal as explicit documentation of intent.
 *
 * @example
 *   // audited (default — no decorator needed)
 *   export class NominationCreatedEvent extends MutationEvent<Nomination> {}
 *
 *   @Auditable(false)
 *   export class GameImportProgressEvent extends MutationEvent<ImportProgress> {}
 *
 * Reading the value (audit listener):
 *   constructor(private readonly reflector: Reflector) {}
 *   // ...
 *   const isAudit = this.reflector.get(Auditable, event.constructor) !== false;
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
 * The mutation kind an audit row records. `create`/`update`/`delete` are
 * derived from which of before/after is null; future variants (e.g.
 * plugin-specific verbs) override the `action` getter instead of widening
 * this union.
 */
export type MutationAction = 'create' | 'update' | 'delete';

/**
 * Base class for mutation events. Concrete events provide a discriminator
 * (e.g. `static readonly eventName`), the payload `T` shape, and the
 * `subject` / `subjectId` pair identifying the mutated row.
 *
 * `before` is `null` on create, `after` is `null` on delete. For updates both
 * are populated with the changed subset (the audit listener diffs at persist
 * time against the `@AuditExclude` denylist). Both `null` is a construction
 * error. `action` derives from which side is null — it is not stored state,
 * so an emit site can never claim `create` while carrying a `before` snapshot.
 *
 * ## Subject identification
 *
 * - `subject`: the domain model name. By convention this is a `ResourceType`
 *   enum value (kept as `string` here so this leaf lib stays decoupled from
 *   the generated database client).
 * - `subjectId`: primary key of the mutated row. Emit sites must include the
 *   id in whichever snapshot is non-null; the usual implementation is
 *   `this.subjectId = (after ?? before).id`.
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
  /** Domain model name of the mutated row (a `ResourceType` value by convention). */
  public abstract readonly subject: string;
  /** Primary key of the mutated row. */
  public abstract readonly subjectId: string;

  public readonly initiatedAt: Date;
  public readonly occurredAt: Date;

  constructor(
    public readonly before: Readonly<Partial<T>> | null,
    public readonly after: Readonly<Partial<T>> | null,
    initiatedAt: Date,
  ) {
    if (before === null && after === null) {
      throw new TypeError(`${new.target.name} requires at least one of before/after`);
    }

    this.initiatedAt = initiatedAt;
    this.occurredAt = new Date();
  }

  /**
   * Derived, never stored: `create` when there is no prior state, `delete`
   * when there is no resulting state, otherwise `update`.
   */
  public get action(): MutationAction {
    if (this.before === null) {
      return 'create';
    }

    return this.after === null ? 'delete' : 'update';
  }
}
