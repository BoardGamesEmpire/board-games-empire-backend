import { MutationEvent } from '@bge/actor-context';
import type {
  GameShareSnapshot,
  Household,
  HouseholdMembershipOrigin,
  MemberInvitePolicy,
  MemberSharePolicy,
  Prisma,
  Reach,
} from '@bge/database';
import { ResourceType } from '@bge/database';
import { HouseholdEvents } from '../constants/household-events.constant';
import type { HOUSEHOLD_SETTINGS_SELECT } from '../read-shapes';

/**
 * Domain mutation events for the Household aggregate (#57, #158, #245).
 *
 * Payloads carry the changed state as projections, never the actor: the
 * acting actor, source, and correlationId live in CLS and are read at handle
 * time by `AuditPersistenceListener`. All events here are audited by default,
 * and each is emitted after commit through `HouseholdEventPublisher`.
 *
 * A household change's domain event names the household as its subject
 * (#245), as the ownership transfer's does (#248): a household's audit
 * entries are one trail, and a webhook's audience check resolves `subjectId`
 * against the household. The snapshots are projections of what changed about
 * it, not rows.
 */

/**
 * A household change's domain event, as `HouseholdEventPublisher` takes it.
 * Each class carries its name on the instance as well as statically, as the
 * invite events do, so the publisher emits an event under its own name and a
 * caller cannot pair it with another's (#245).
 */
export type HouseholdDomainEvent = MutationEvent<unknown> & { readonly eventName: HouseholdEvents };

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
 * audit entry reads "household X's owner went from A to B", and the companion
 * webhook's dispatch-time visibility check resolves `subjectId` against
 * `descriptor.subject` — a `HouseholdRole` id checked against `Household` would
 * find no row and the webhook would silently never fire.
 *
 * Both snapshots are populated, so `action` derives to `update`.
 */
export class HouseholdOwnershipTransferredEvent extends MutationEvent<HouseholdOwnershipSnapshot> {
  static readonly eventName = HouseholdEvents.OwnershipTransferred;
  readonly eventName = HouseholdOwnershipTransferredEvent.eventName;
  declare readonly before: HouseholdOwnershipSnapshot;
  declare readonly after: HouseholdOwnershipSnapshot;
  readonly subject = ResourceType.Household;
  readonly subjectId: string;

  constructor(before: HouseholdOwnershipSnapshot, after: HouseholdOwnershipSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.householdId;
  }
}

/**
 * Emitted once, after commit, when a household owner or admin approves a
 * member's waiting game share (#810), which puts it in effect.
 *
 * `subject`/`subjectId` are the share, the row the approval changed: its
 * `approvedAt` and `approvedById` go from null to set. Both snapshots are
 * populated, so `action` derives to `update`. They are `GameShareSnapshot`s,
 * the shape the share's created and deleted events in `@bge/game` carry.
 */
export class HouseholdGameShareApprovedEvent extends MutationEvent<GameShareSnapshot> {
  static readonly eventName = HouseholdEvents.GameShareApproved;
  readonly eventName = HouseholdGameShareApprovedEvent.eventName;
  declare readonly before: GameShareSnapshot;
  declare readonly after: GameShareSnapshot;
  readonly subject = ResourceType.GameShare;
  readonly subjectId: string;

  constructor(before: GameShareSnapshot, after: GameShareSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/**
 * Emitted once per share, after commit, when a member leaves the household or
 * is removed from it and their game shares into it end with the membership
 * (#810), waiting and in effect alike.
 *
 * `subject`/`subjectId` are the share, the row the departure deleted. Only
 * `before` is populated, so `action` derives to `delete`, as it does for the
 * share's deleted event in `@bge/game`, whose `GameShareSnapshot` it carries.
 * Without it, a share's audit trail would show its creation and never its end.
 */
export class HouseholdGameShareEndedEvent extends MutationEvent<GameShareSnapshot> {
  static readonly eventName = HouseholdEvents.GameShareEnded;
  readonly eventName = HouseholdGameShareEndedEvent.eventName;
  declare readonly before: GameShareSnapshot;
  declare readonly after: null;
  readonly subject = ResourceType.GameShare;
  readonly subjectId: string;

  constructor(before: GameShareSnapshot, initiatedAt: Date) {
    super(before, null, initiatedAt);
    this.subjectId = before.id;
  }
}

/** Why a membership ended, as the member-removed domain event records it (#245). */
export enum MembershipEndCause {
  /** A household owner or admin removed the member from the household. */
  Removed = 'removed',
  /** The member left the household. */
  Left = 'left',
  /** The member was banned from the household, which ends their membership (#782). */
  Banned = 'banned',
}

/**
 * The household's columns and settings an edit can change, flattened so one
 * diff covers both (#245). An edit records only the columns whose values
 * changed, so its domain event carries a subset of these, plus `id`.
 */
export interface HouseholdStateSnapshot {
  readonly description: string | null;

  /**
   * Who besides members and guests may open the game pool (#367). Null for a
   * household with no settings row.
   */
  readonly gamePoolReach: Reach | null;

  readonly id: string;
  readonly image: string | null;
  readonly languageTagId: string | null;

  /** Null for a household with no settings row. */
  readonly memberInvitePolicy: MemberInvitePolicy | null;

  /** Null for a household with no settings row. */
  readonly memberSharePolicy: MemberSharePolicy | null;

  readonly name: string;
  readonly reach: Reach;
}

/** A household as its create left it: its own columns, without the settings the create defaults. */
export type HouseholdCreatedSnapshot = Pick<
  HouseholdStateSnapshot,
  'description' | 'id' | 'image' | 'languageTagId' | 'name' | 'reach'
>;

/** The columns an edit changed, on one side of it, and the household's id. */
export type HouseholdUpdatedSnapshot = Partial<HouseholdStateSnapshot> & Pick<HouseholdStateSnapshot, 'id'>;

/**
 * A household as its soft delete found it (#245). Audit only: its webhook
 * carries the household's id and nothing more.
 */
export interface HouseholdDeletedSnapshot {
  readonly id: string;
  readonly name: string;

  /**
   * The household owners the delete gave a restore window, by user id. Empty
   * for a staff delete, which gives none.
   */
  readonly restoreWindowUserIds: readonly string[];
}

/**
 * One side of a household's restore (#175, #245): `deletedAt` goes from set to
 * null, and the restore windows the delete gave end. Audit only, as the
 * deleted snapshot is.
 */
export interface HouseholdRestoreSnapshot {
  readonly deletedAt: Date | null;
  readonly id: string;

  /** The users holding a restore window for the household, by user id. */
  readonly restoreWindowUserIds: readonly string[];
}

/**
 * One user's membership of the household, on one side of a change to it
 * (#245). The side with no membership has a null `memberId` and `role`.
 */
export interface HouseholdMembershipSnapshot {
  /** Why the membership ended, on the after side of a member-removed domain event only. */
  readonly cause?: MembershipEndCause;

  readonly householdId: string;

  /** The `HouseholdMember` row's id, or null on the side with no membership. */
  readonly memberId: string | null;

  /** How the member came to belong, on the after side of a member-admitted domain event. */
  readonly origin?: HouseholdMembershipOrigin;

  /** The member's household role by name, or null on the side with no membership. */
  readonly role: string | null;

  readonly userId: string;
}

/**
 * One user's ban from the household, on one side of a change to it (#782,
 * #245). The side with no ban has a null `banId` and `reason`. The reason is
 * in the audit entry, which only staff read, and no ban has a webhook, which
 * would send it to an outside address.
 */
export interface HouseholdBanSnapshot {
  /** The `HouseholdBan` row's id, or null on the side with no ban. */
  readonly banId: string | null;

  readonly householdId: string;

  /** The ban's reason, or null on the side with no ban. */
  readonly reason: string | null;

  readonly userId: string;
}

/**
 * A household row as {@link householdStateSnapshot} reads it: its own columns
 * and its settings, as `settings: { select: HOUSEHOLD_SETTINGS_SELECT }` reads
 * them, null when the household has no settings row.
 */
export type HouseholdStateRow = Pick<Household, 'description' | 'id' | 'image' | 'languageTagId' | 'name' | 'reach'> & {
  readonly settings: Prisma.HouseholdSettingsGetPayload<{ select: typeof HOUSEHOLD_SETTINGS_SELECT }> | null;
};

/**
 * Flattens a household and its settings into the one snapshot an edit is
 * diffed on (#245), taking only the columns an edit can change.
 */
export function householdStateSnapshot(row: HouseholdStateRow): HouseholdStateSnapshot {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    image: row.image,
    reach: row.reach,
    languageTagId: row.languageTagId,
    memberInvitePolicy: row.settings?.memberInvitePolicy ?? null,
    memberSharePolicy: row.settings?.memberSharePolicy ?? null,
    gamePoolReach: row.settings?.gamePoolReach ?? null,
  };
}

/**
 * Emitted once, after commit, when a household is created (#245), and only on
 * a fresh create: a replayed create changed nothing (#210). Only `after` is
 * populated, so `action` derives to `create`.
 */
export class HouseholdCreatedEvent extends MutationEvent<HouseholdCreatedSnapshot> {
  static readonly eventName = HouseholdEvents.Created;
  readonly eventName = HouseholdCreatedEvent.eventName;
  declare readonly before: null;
  declare readonly after: HouseholdCreatedSnapshot;
  readonly subject = ResourceType.Household;
  readonly subjectId: string;

  constructor(after: HouseholdCreatedSnapshot, initiatedAt: Date) {
    super(null, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/**
 * Emitted once, after commit, when an edit changes a household's columns or
 * settings (#245). Each side carries only the columns that changed, plus `id`;
 * an edit that changes nothing emits nothing (#728).
 */
export class HouseholdUpdatedEvent extends MutationEvent<HouseholdStateSnapshot> {
  static readonly eventName = HouseholdEvents.Updated;
  readonly eventName = HouseholdUpdatedEvent.eventName;
  declare readonly before: HouseholdUpdatedSnapshot;
  declare readonly after: HouseholdUpdatedSnapshot;
  readonly subject = ResourceType.Household;
  readonly subjectId: string;

  constructor(before: HouseholdUpdatedSnapshot, after: HouseholdUpdatedSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/**
 * Emitted once, after commit, when a household is soft-deleted (#245). The
 * delete stamps `deletedAt`, and is modeled as a domain delete, as
 * `EventDeletedEvent` is: only `before` is populated, so `action` derives to
 * `delete`.
 */
export class HouseholdDeletedEvent extends MutationEvent<HouseholdDeletedSnapshot> {
  static readonly eventName = HouseholdEvents.Deleted;
  readonly eventName = HouseholdDeletedEvent.eventName;
  declare readonly before: HouseholdDeletedSnapshot;
  declare readonly after: null;
  readonly subject = ResourceType.Household;
  readonly subjectId: string;

  constructor(before: HouseholdDeletedSnapshot, initiatedAt: Date) {
    super(before, null, initiatedAt);
    this.subjectId = before.id;
  }
}

/**
 * Emitted once, after commit, when a soft-deleted household is restored
 * (#175, #245). Both snapshots are populated, so `action` derives to `update`.
 */
export class HouseholdRestoredEvent extends MutationEvent<HouseholdRestoreSnapshot> {
  static readonly eventName = HouseholdEvents.Restored;
  readonly eventName = HouseholdRestoredEvent.eventName;
  declare readonly before: HouseholdRestoreSnapshot;
  declare readonly after: HouseholdRestoreSnapshot;
  readonly subject = ResourceType.Household;
  readonly subjectId: string;

  constructor(before: HouseholdRestoreSnapshot, after: HouseholdRestoreSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/**
 * Emitted once, after commit, when a user is admitted to the household
 * (#245). The household changed, not a row of its own, so `action` derives to
 * `update`: `before` is the same user with no membership.
 */
export class HouseholdMemberAdmittedEvent extends MutationEvent<HouseholdMembershipSnapshot> {
  static readonly eventName = HouseholdEvents.MemberAdmitted;
  readonly eventName = HouseholdMemberAdmittedEvent.eventName;
  declare readonly before: HouseholdMembershipSnapshot;
  declare readonly after: HouseholdMembershipSnapshot;
  readonly subject = ResourceType.Household;
  readonly subjectId: string;

  constructor(after: HouseholdMembershipSnapshot, initiatedAt: Date) {
    super({ householdId: after.householdId, userId: after.userId, memberId: null, role: null }, after, initiatedAt);
    this.subjectId = after.householdId;
  }
}

/**
 * Emitted once, after commit, when a member's household role changes (#245),
 * and only when it does. Both snapshots are populated, so `action` derives to
 * `update`.
 */
export class HouseholdMemberRoleChangedEvent extends MutationEvent<HouseholdMembershipSnapshot> {
  static readonly eventName = HouseholdEvents.MemberRoleChanged;
  readonly eventName = HouseholdMemberRoleChangedEvent.eventName;
  declare readonly before: HouseholdMembershipSnapshot;
  declare readonly after: HouseholdMembershipSnapshot;
  readonly subject = ResourceType.Household;
  readonly subjectId: string;

  constructor(before: HouseholdMembershipSnapshot, after: HouseholdMembershipSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.householdId;
  }
}

/**
 * Emitted once, after commit, when a membership ends (#245): the member left,
 * was removed from the household or was banned. One domain event for every
 * cause, and `after` says which: the same user with no membership, and the
 * cause.
 * `action` derives to `update`, since the household is what changed.
 */
export class HouseholdMemberRemovedEvent extends MutationEvent<HouseholdMembershipSnapshot> {
  static readonly eventName = HouseholdEvents.MemberRemoved;
  readonly eventName = HouseholdMemberRemovedEvent.eventName;
  declare readonly before: HouseholdMembershipSnapshot;
  declare readonly after: HouseholdMembershipSnapshot;
  readonly subject = ResourceType.Household;
  readonly subjectId: string;

  constructor(before: HouseholdMembershipSnapshot, cause: MembershipEndCause, initiatedAt: Date) {
    super(
      before,
      { householdId: before.householdId, userId: before.userId, memberId: null, role: null, cause },
      initiatedAt,
    );
    this.subjectId = before.householdId;
  }
}

/**
 * Emitted once, after commit, when a user is banned from the household (#782,
 * #245). `before` is the same user with no ban, so `action` derives to
 * `update`. No webhook: the ban's reason stays out of outside addresses.
 */
export class HouseholdBanCreatedEvent extends MutationEvent<HouseholdBanSnapshot> {
  static readonly eventName = HouseholdEvents.BanCreated;
  readonly eventName = HouseholdBanCreatedEvent.eventName;
  declare readonly before: HouseholdBanSnapshot;
  declare readonly after: HouseholdBanSnapshot;
  readonly subject = ResourceType.Household;
  readonly subjectId: string;

  constructor(after: HouseholdBanSnapshot, initiatedAt: Date) {
    super({ householdId: after.householdId, userId: after.userId, banId: null, reason: null }, after, initiatedAt);
    this.subjectId = after.householdId;
  }
}

/**
 * Emitted once, after commit, when a ban's reason changes (#782, #245), and
 * only when it does. Both snapshots are populated, so `action` derives to
 * `update`. No webhook, as for the ban itself.
 */
export class HouseholdBanUpdatedEvent extends MutationEvent<HouseholdBanSnapshot> {
  static readonly eventName = HouseholdEvents.BanUpdated;
  readonly eventName = HouseholdBanUpdatedEvent.eventName;
  declare readonly before: HouseholdBanSnapshot;
  declare readonly after: HouseholdBanSnapshot;
  readonly subject = ResourceType.Household;
  readonly subjectId: string;

  constructor(before: HouseholdBanSnapshot, after: HouseholdBanSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.householdId;
  }
}

/**
 * Emitted once, after commit, when a ban is lifted (#782, #245). `after` is the
 * same user with no ban, so `action` derives to `update`. No webhook, as for
 * the ban itself.
 */
export class HouseholdBanLiftedEvent extends MutationEvent<HouseholdBanSnapshot> {
  static readonly eventName = HouseholdEvents.BanLifted;
  readonly eventName = HouseholdBanLiftedEvent.eventName;
  declare readonly before: HouseholdBanSnapshot;
  declare readonly after: HouseholdBanSnapshot;
  readonly subject = ResourceType.Household;
  readonly subjectId: string;

  constructor(before: HouseholdBanSnapshot, initiatedAt: Date) {
    super(before, { householdId: before.householdId, userId: before.userId, banId: null, reason: null }, initiatedAt);
    this.subjectId = before.householdId;
  }
}
