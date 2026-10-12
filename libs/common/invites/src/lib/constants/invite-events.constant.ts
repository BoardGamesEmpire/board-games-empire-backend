/**
 * EventEmitter2 names for the invite lifecycle.
 *
 * These are the INTERNAL domain-event names: the audit listener, the
 * notification listener (#167, #682) and any future transport (#173) subscribe
 * to them. They are not webhook wire names. No invite webhook exists, and
 * whether one should is a per-event decision on #245.
 *
 * All but one are emitted by a CONSUMER of `@bge/invites` after its
 * transaction commits, through `InviteService.emit(...)`; the lib never emits
 * inside a transaction that could still roll back. `invite.expired` is the
 * exception: a transition that meets an expired row stamps it on the lib's own
 * connection, outside any transaction, and announces it at once.
 */
export enum InviteEvents {
  Created = 'invite.created',
  Accepted = 'invite.accepted',
  Declined = 'invite.declined',
  Withdrawn = 'invite.withdrawn',
  Revoked = 'invite.revoked',
  Approved = 'invite.approved',
  Expired = 'invite.expired',
}
