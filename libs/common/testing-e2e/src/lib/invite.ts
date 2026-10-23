import { InviteStatus, InviteType, type Invite, type PrismaClient } from '@bge/database';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedActor } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface InviteArrangement {
  readonly inviter: Pick<AuthenticatedActor, 'user'>;

  /** The context: a household, or an event when `eventId` is set instead. */
  readonly householdId?: string | null;
  readonly eventId?: string | null;

  /** Who it is to: an account by id, an address, or both, as the suite needs. */
  readonly inviteeId?: string | null;
  readonly inviteeEmail?: string | null;

  /** `Pending` when omitted. */
  readonly status?: InviteStatus;

  /** A day from now when omitted. */
  readonly expiresAt?: Date;

  readonly withheld?: boolean;
  readonly needsApproval?: boolean;
  readonly approvedAt?: Date | null;
  readonly roleId?: string | null;
}

/**
 * An invite in any state, arranged directly in the database (#257, #747),
 * for a suite that needs one the routes can't make: a settled one, an expired
 * one, one to an address nobody has, or one into a household the inviter has
 * since left. A suite that tests creating invites goes through the route.
 *
 * It is a household invite unless `eventId` is set. `token` is random rather
 * than sequential for the reason `prepareSignup` gives: it is unique, and a
 * predictable value is what lets state survive a truncate and collide with a
 * later test (#268).
 *
 * Extracted when the seventh suite kept its own copy, on the concrete-first
 * rule `apps/api-e2e/src/support/wire.ts` describes.
 */
export function arrangeInvite(
  prisma: PrismaClient,
  { inviter, householdId = null, eventId = null, status = InviteStatus.Pending, expiresAt, ...rest }: InviteArrangement,
): Promise<Invite> {
  return prisma.invite.create({
    data: {
      type: eventId === null ? InviteType.Household : InviteType.Event,
      inviterId: inviter.user.id,
      householdId,
      eventId,
      status,
      token: randomUUID(),
      expiresAt: expiresAt ?? new Date(Date.now() + DAY_MS),
      ...rest,
    },
  });
}
