import { AuditExclude, MutationEvent } from '@bge/actor-context';
import { InviteStatus, InviteType, ResourceType } from '@bge/database';
import { InviteEvents } from '../constants/invite-events.constant';

/**
 * Domain events for the invite lifecycle (#161).
 *
 * Payloads carry ROW STATE only; the acting actor, source and correlationId
 * live in CLS and are read at handle time by `AuditPersistenceListener`, never
 * on the payload. Every domain event here is audited by default.
 *
 * Each is constructed by `InviteService` inside the consumer's transaction and
 * handed back to the consumer, who emits it AFTER commit through
 * `InviteService.emit(...)`. Emitting inside the transaction would tell
 * listeners about a transition a rollback then undoes. The one exception is
 * the `invite.expired` a refused transition leaves behind: the lib writes that
 * stamp on its own connection, detached from the request, and announces it
 * itself once the write lands. (An `invite.expired` a create stamps on the
 * way in rides back to the consumer like every other domain event.)
 */

/**
 * What every invite domain event carries about the row, as a diffable
 * projection.
 *
 * The party and context ids are here so a listener can resolve its recipients
 * from the payload alone: who was invited, who invited them, and into what.
 * That is what lets #167's and #682's listeners run without re-reading the
 * invite, and what lets a sweep (#165) emit for rows no request is looking at.
 *
 * `token` is NEVER on a snapshot. It is the accept credential for an email-only
 * invite, and a domain event reaches the audit log, in-process listeners and
 * anything they forward to. `message` and `metadata` are left off too: the
 * first is free text addressed to one invitee, the second an untyped payload
 * with no reader.
 */
export interface InviteSnapshot {
  readonly id: string;
  readonly type: InviteType;
  readonly status: InviteStatus;
  readonly inviterId: string;
  readonly inviteeId: string | null;
  readonly inviteeName: string | null;
  /** Stripped from persisted audit rows; in-process listeners still receive it. */
  readonly inviteeEmail: string | null;
  readonly householdId: string | null;
  readonly eventId: string | null;
  readonly roleId: string | null;
  readonly expiresAt: Date;
  readonly respondedAt: Date | null;
}

/**
 * The one spelling of the snapshot's fields. {@link toInviteSnapshot} and the
 * lib's `INVITE_SNAPSHOT_SELECT` are both built from it, so neither can drift
 * from the other. `satisfies` holds every entry to a real field; that the list
 * is COMPLETE is pinned by `invite.events.spec.ts`, which compares it to a
 * `Record<keyof InviteSnapshot, true>` the compiler will not let fall short.
 */
export const INVITE_SNAPSHOT_FIELDS = [
  'id',
  'type',
  'status',
  'inviterId',
  'inviteeId',
  'inviteeName',
  'inviteeEmail',
  'householdId',
  'eventId',
  'roleId',
  'expiresAt',
  'respondedAt',
] as const satisfies readonly (keyof InviteSnapshot)[];

export type InviteSnapshotField = (typeof INVITE_SNAPSHOT_FIELDS)[number];

/**
 * Projects a row onto {@link InviteSnapshot}, field by field from the list.
 *
 * A row read for a transition carries more than the snapshot. Copying by the
 * list means it contributes exactly these twelve fields and nothing else; a
 * spread would carry `token` along the moment someone selected it.
 */
export function toInviteSnapshot(row: InviteSnapshot): InviteSnapshot {
  const snapshot: Partial<Record<InviteSnapshotField, unknown>> = {};

  for (const field of INVITE_SNAPSHOT_FIELDS) {
    snapshot[field] = row[field];
  }

  // Every field of the interface is in the list (pinned by the spec), so the
  // partial is whole by the time it is returned.
  return snapshot as InviteSnapshot;
}

/**
 * The address stays on the in-process payload, so a notification listener can
 * reach an invitee who is not a registered user, and is stripped from
 * persisted audit snapshots on the precedent of `UserCreatedEvent`'s `email`.
 */
const INVITE_AUDIT_EXCLUDED = ['inviteeEmail'] satisfies readonly (keyof InviteSnapshot & string)[];

/**
 * Emitted once, after commit, when an invite row is created.
 *
 * `before` is null, so `action` derives to `create`.
 */
@AuditExclude(INVITE_AUDIT_EXCLUDED)
export class InviteCreatedEvent extends MutationEvent<InviteSnapshot> {
  static readonly eventName = InviteEvents.Created;
  readonly eventName = InviteCreatedEvent.eventName;

  declare readonly before: null;
  declare readonly after: InviteSnapshot;

  readonly subject = ResourceType.Invite;
  readonly subjectId: string;

  constructor(after: InviteSnapshot, initiatedAt: Date) {
    super(null, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/**
 * A status transition on an existing row. Both snapshots are populated, so
 * `action` derives to `update`, and `before.status` is the status the row was
 * actually in: the lib reads it before the guarded update rather than
 * guessing from the transition's allowed sources.
 */
export abstract class InviteTransitionEvent extends MutationEvent<InviteSnapshot> {
  abstract readonly eventName: InviteEvents;

  declare readonly before: InviteSnapshot;
  declare readonly after: InviteSnapshot;

  readonly subject = ResourceType.Invite;
  readonly subjectId: string;

  constructor(before: InviteSnapshot, after: InviteSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/** How `InviteService` constructs a transition's domain event. */
export type InviteTransitionEventClass<Event extends InviteTransitionEvent = InviteTransitionEvent> = new (
  before: InviteSnapshot,
  after: InviteSnapshot,
  initiatedAt: Date,
) => Event;

/** The invitee accepted; the consumer admits them in the same transaction (#163). */
@AuditExclude(INVITE_AUDIT_EXCLUDED)
export class InviteAcceptedEvent extends InviteTransitionEvent {
  static readonly eventName = InviteEvents.Accepted;
  readonly eventName = InviteAcceptedEvent.eventName;
}

/** The invitee declined, from either outstanding status. */
@AuditExclude(INVITE_AUDIT_EXCLUDED)
export class InviteDeclinedEvent extends InviteTransitionEvent {
  static readonly eventName = InviteEvents.Declined;
  readonly eventName = InviteDeclinedEvent.eventName;
}

/** The inviter took the invite back. */
@AuditExclude(INVITE_AUDIT_EXCLUDED)
export class InviteWithdrawnEvent extends InviteTransitionEvent {
  static readonly eventName = InviteEvents.Withdrawn;
  readonly eventName = InviteWithdrawnEvent.eventName;
}

/** A context authority cancelled it: an owner or admin, or the household being deleted. */
@AuditExclude(INVITE_AUDIT_EXCLUDED)
export class InviteRevokedEvent extends InviteTransitionEvent {
  static readonly eventName = InviteEvents.Revoked;
  readonly eventName = InviteRevokedEvent.eventName;
}

/** An approver moved it from AwaitingApproval to Pending (#166). */
@AuditExclude(INVITE_AUDIT_EXCLUDED)
export class InviteApprovedEvent extends InviteTransitionEvent {
  static readonly eventName = InviteEvents.Approved;
  readonly eventName = InviteApprovedEvent.eventName;
}

/** The clock closed it: stamped by a transition that met it expired, or by #165's sweep. */
@AuditExclude(INVITE_AUDIT_EXCLUDED)
export class InviteExpiredEvent extends InviteTransitionEvent {
  static readonly eventName = InviteEvents.Expired;
  readonly eventName = InviteExpiredEvent.eventName;
}

/** Every domain event `InviteService` hands back for a consumer to emit. */
export type InviteDomainEvent =
  | InviteCreatedEvent
  | InviteAcceptedEvent
  | InviteDeclinedEvent
  | InviteWithdrawnEvent
  | InviteRevokedEvent
  | InviteApprovedEvent
  | InviteExpiredEvent;
