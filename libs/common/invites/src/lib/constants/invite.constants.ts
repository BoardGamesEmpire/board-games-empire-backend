import { InviteStatus } from '@bge/database';

/**
 * The statuses an invite can still move out of. Everything else is terminal:
 * `Accepted`, `Declined`, `Expired`, `Revoked` and `Withdrawn` never change
 * again.
 *
 * Both are inside the partial unique indexes of
 * `20261012000000_invite_outstanding_unique`, so "outstanding" here and
 * "outstanding" in the database are the same set by construction.
 *
 * The ORDER is load-bearing for a bulk statement that visits one status at a
 * time (`InviteService.settleOutstandingWithin`): the only transition between
 * the two is approve, `AwaitingApproval` to `Pending`, never back. Visiting
 * `AwaitingApproval` first means a row a rival approve moves in between is
 * `Pending` by the second statement and still caught; the other order would
 * let it slip past both.
 */
export const OUTSTANDING_INVITE_STATUSES = [InviteStatus.AwaitingApproval, InviteStatus.Pending] as const;

export type OutstandingInviteStatus = (typeof OUTSTANDING_INVITE_STATUSES)[number];

/** How long an invite stays open when its creator names no `expiresAt`. */
export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Entropy behind `Invite.token`: 32 random bytes, rendered base64url (43
 * characters), the same minting `WebhookSubscriptionService.generateSecret`
 * uses. The token is stored as minted; hashing it at rest is #173's question.
 */
export const INVITE_TOKEN_BYTES = 32;

/**
 * How many times `createWithin` mints a token before giving up. A collision on
 * 256 random bits is not expected in the lifetime of the universe; the bound
 * exists so a broken random source surfaces as an error rather than a spin.
 */
export const INVITE_TOKEN_MINT_ATTEMPTS = 3;

/**
 * The partial unique indexes that refuse a duplicate outstanding invite, in
 * every spelling a P2002 identity can report them (see `identifiesConstraint`):
 * raw column pairs from the driver adapter, Prisma field pairs from a restored
 * `meta.target`, and the index names.
 */
export const OUTSTANDING_INVITE_UNIQUE_COLUMNS = [
  ['household_id', 'invitee_id'],
  ['household_id', 'invitee_email'],
  ['event_id', 'invitee_id'],
  ['event_id', 'invitee_email'],
] as const;

export const OUTSTANDING_INVITE_UNIQUE_FIELDS = [
  ['householdId', 'inviteeId'],
  ['householdId', 'inviteeEmail'],
  ['eventId', 'inviteeId'],
  ['eventId', 'inviteeEmail'],
] as const;

export const OUTSTANDING_INVITE_UNIQUE_INDEXES = [
  'invites_household_invitee_outstanding_unique',
  'invites_household_invitee_email_outstanding_unique',
  'invites_event_invitee_outstanding_unique',
  'invites_event_invitee_email_outstanding_unique',
] as const;

/** `Invite.token`'s `@unique`, as the driver adapter and a restored `meta.target` both spell it. */
export const INVITE_TOKEN_UNIQUE_COLUMNS = ['token'] as const;
