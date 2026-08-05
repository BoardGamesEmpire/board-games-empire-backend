import { MutationEvent } from '@bge/actor-context';
import { ResourceType } from '@bge/database';
import { HouseholdEvents } from '../constants/household-events.constant';

/**
 * Domain mutation events for the Household aggregate (#57 emit-site migration,
 * first site landed by #158).
 *
 * Payloads carry ROW STATE only; the acting actor, source, and correlationId
 * live in CLS and are read at handle time by `AuditPersistenceListener` — never
 * on the payload. All events here are audited by default.
 */

/**
 * Who owns a household, as a diffable projection.
 *
 * Deliberately NOT a `Pick<HouseholdRole, …>`. The mutation writes two
 * `HouseholdRole` rows, and `MutationEvent`'s before/after is a single-row diff
 * shape — keying the event to one of the two rows would make the audit trail
 * describe half the change and put a role-row id in `subjectId`, where every
 * consumer (the audit UI, the webhook visibility check) expects the id of the
 * aggregate the change is about. The thing that changed is the household's
 * ownership, so that is what the snapshot models.
 */
export interface HouseholdOwnershipSnapshot {
  readonly householdId: string;
  /** `HouseholdMember.id` of the owning member. */
  readonly ownerMemberId: string;
  readonly ownerUserId: string;
}

/**
 * Emitted once, after commit, when household ownership changes hands (#158).
 *
 * `subject`/`subjectId` are the household, not either `HouseholdRole` row: the
 * audit row reads "household X's owner went from A to B", and the companion
 * webhook's dispatch-time visibility check resolves `subjectId` against
 * `descriptor.subject` — a `HouseholdRole` id checked against `Household` would
 * find no row and the webhook would silently never fire.
 *
 * Both snapshots are populated, so `action` derives to `update`.
 */
export class HouseholdOwnershipTransferredEvent extends MutationEvent<HouseholdOwnershipSnapshot> {
  static readonly eventName = HouseholdEvents.OwnershipTransferred;

  declare readonly before: HouseholdOwnershipSnapshot;
  declare readonly after: HouseholdOwnershipSnapshot;

  readonly subject = ResourceType.Household;
  readonly subjectId: string;

  constructor(before: HouseholdOwnershipSnapshot, after: HouseholdOwnershipSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.householdId;
  }
}
