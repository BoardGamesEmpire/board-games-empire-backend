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
 * Actor / source / correlationId are intentionally NOT carried on the event
 * itself. The Phase 2 wildcard listener reads them from CLS at handle time
 * (nestjs-cls propagates context through EventEmitter2 listeners). Keeping
 * them off the payload prevents drift and avoids forging.
 */
export abstract class MutationEvent<T = unknown> {
  constructor(
    public readonly before: Readonly<Partial<T>> | null,
    public readonly after: Readonly<Partial<T>> | null,
  ) {}
}
