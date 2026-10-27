import { Prisma } from '@bge/database';
import { INVITE_SNAPSHOT_FIELDS, type InviteSnapshotField } from './events/invite.events';

/**
 * Select-shaped read surfaces for invites, owned here so every consumer of
 * `@bge/invites` renders an invite the same way (#161).
 *
 * ## Why these are `select` and not `include`
 *
 * Prisma's `include:` means "every scalar column on the model, plus these
 * relations". The routes that return invites hand service payloads to clients
 * directly, so nothing downstream strips what a query over-fetched, and under
 * `include:` every column added to the model is an implicit API change. That
 * is how `Invite.token`, a live accept credential, reached every holder of
 * `read:household` and every friend of a member on a `Friends`-visible
 * household, through the household detail (#297). The detail embeds no
 * invites now (#665).
 *
 * A `select` shape inverts the default: a new column is invisible until someone
 * names it here. `read-shapes.spec.ts` enforces that by reading the model's
 * scalars out of the generated client, so a column added to `prisma/models`
 * fails the suite until it is classified as published, party-only, or withheld
 * (#297).
 *
 * ## Two audiences, two shapes
 *
 * {@link CONTEXT_INVITE_SELECT} is what a context reader sees: staff listing a
 * household's invites, and the base of what a household owner or admin sees. {@link
 * PARTY_INVITE_SELECT} is that plus the two columns that belong to the people
 * on the invite, `inviteeEmail` and `message`, rendered only on rows whose
 * inviter or invitee is the acting user (#459, option c). The lib's own
 * transitions return the party shape to a party and the context shape to a
 * context authority; a consumer listing invites for a context must not widen
 * to the party shape, since that re-opens #297's class for the address. The
 * household lib adds the address alone, never the message, for the
 * household's own owners and admins, as its roster names them (#167).
 */

/**
 * How the inviter is rendered. The household roster renders a member's `user`
 * the same way; `libs/api/household/src/lib/read-shapes.spec.ts` pins that the
 * two cannot drift into different spellings of a user.
 */
const INVITE_ACTOR_SELECT = {
  id: true,
  username: true,
  profile: {
    select: {
      avatarUrl: true,
      displayName: true,
    },
  },
} as const satisfies Prisma.UserSelect;

/**
 * An invite as a context reader sees it (#297): a row of a household's invite
 * list, a revoke or approve result.
 *
 * `role` is rendered as an object rather than the bare `roleId` the model
 * carries, so "invited as Admin" reads the same way the household's roster
 * renders a member's role.
 */
export const CONTEXT_INVITE_SELECT = {
  id: true,
  status: true,
  type: true,
  inviteeName: true,
  expiresAt: true,
  createdAt: true,

  role: { select: { id: true, name: true } },

  inviter: { select: INVITE_ACTOR_SELECT },
} as const satisfies Prisma.InviteSelect;

/**
 * An invite as one of its parties sees it: the context shape plus the two
 * columns addressed to the people on the invite (#161).
 *
 * Returned by the lib's create, accept, decline, withdraw and party read, each
 * of which binds the acting user to the row as inviter or invitee first. Never
 * used for a context read.
 */
export const PARTY_INVITE_SELECT = {
  ...CONTEXT_INVITE_SELECT,
  inviteeEmail: true,
  message: true,
} as const satisfies Prisma.InviteSelect;

/**
 * `Invite` scalars withheld from EVERY client shape, and why.
 *
 * Adding a column to the model without adding it here, to
 * {@link INVITE_SCALARS_PARTY_ONLY}, or to {@link CONTEXT_INVITE_SELECT} fails
 * `read-shapes.spec.ts`. That failure is the point: it forces the visibility of
 * a new column to be decided once, deliberately, rather than inherited from
 * `include:` semantics.
 */
export const INVITE_SCALARS_OMITTED = {
  token:
    'THE accept credential (`@unique`, "email confirmation token"). The context shape reaches every reader of the invites in a context, and the party shape the invitee it is meant for. Under the old household detail embed that meant every holder of read:household, non-members included (#297). Publishing it anywhere is an authorization bypass once accept is token-reachable (#163). Never select this.',
  inviterId: 'Superseded by the `inviter` relation above, which renders the user rather than an opaque id.',
  roleId: 'Superseded by the `role` relation above (#297).',
  inviteeId: 'Internal linkage. The invitee is identified to clients by `inviteeName`.',
  eventId: 'Not meaningful on a household read; an event invite reaches clients through the event routes.',
  householdId:
    'Redundant: a context read is nested under the context it belongs to, and a party already knows which invite they acted on.',
  metadata: 'Untyped internal payload for system invites (#161). Never a client contract.',
  needsApproval:
    "Approval bookkeeping: set when the consumer wanted an approver first, as a household does for a member's invite (#166). `status` already says whether it still waits.",
  approvedById: 'Who approved the invite (#166). Same social-inference concern as `HouseholdMember.addedById`.',
  approvedAt: 'Approval bookkeeping (#166); `status` is the client-facing answer.',
  respondedAt: 'Lifecycle bookkeeping; `status` is the client-facing answer.',
  updatedAt: 'Row bookkeeping. `expiresAt` and `createdAt` are what a pending invite is judged by.',
  withheld:
    "Set when a block or the invitee's preference refused an invite by address (#278). The invite answers like any other so the inviter cannot tell, and any shape carrying this column would tell them. Only what delivers invites reads it, from the row.",
} as const satisfies Partial<Record<Prisma.InviteScalarFieldEnum, string>>;

/**
 * `Invite` scalars withheld from the context shape and published by the party
 * shape, and why (#161, answering #459 as its option c). The household lib
 * also publishes `inviteeEmail`, never `message`, to the household's own
 * owners and admins (#167).
 */
export const INVITE_SCALARS_PARTY_ONLY = {
  inviteeEmail:
    "An address belonging to someone who may not be a registered user. Harvestable by every co-member under the old shape, and withheld from the context shape by #297. The inviter typed it and the invitee owns it, so each sees it on their own rows, and the household's owners and admins see it on their household's invites (#167).",
  // Not a response body: this key is the NAME of the `Invite.message` column,
  // and the string beside it is the reason the column is party-only. The i18n
  // rule (#144/#145) flags every `message:` key that holds a literal, because
  // a response body or a validator spells its copy that way; a ledger keyed by
  // column name is neither. This lib's own eslint config applies that rule, so
  // lint it through the Nx target; a bare `eslint` run from the workspace root
  // sees only the root config and reports the directive below as unused.
  // eslint-disable-next-line no-restricted-syntax -- a column name, not user-facing copy
  message: 'Free text addressed to the invitee, not to the household at large.',
} as const satisfies Partial<Record<Prisma.InviteScalarFieldEnum, string>>;

/**
 * The scalars every invite domain event carries (#161), as a select built
 * from the same list the snapshot projection reads. Internal to the lib: a
 * transition reads these alongside the party shape so it can build both the
 * domain event and the returned view from one row. `token` is not in the list
 * and must never be; `read-shapes.spec.ts` pins it.
 */
export const INVITE_SNAPSHOT_SELECT = Object.fromEntries(INVITE_SNAPSHOT_FIELDS.map((field) => [field, true])) as {
  readonly [Field in InviteSnapshotField]: true;
};

/**
 * What a transition reads and writes back: the party shape plus the snapshot
 * scalars. The lib projects a result down to the party or context shape and
 * the domain event down to the snapshot; nothing returns this row whole.
 */
export const TRANSITION_SELECT = {
  ...PARTY_INVITE_SELECT,
  ...INVITE_SNAPSHOT_SELECT,
} as const satisfies Prisma.InviteSelect;

/** An invite as a context reader receives it. */
export type InviteContextView = Prisma.InviteGetPayload<{ select: typeof CONTEXT_INVITE_SELECT }>;

/** An invite as one of its parties receives it. */
export type InvitePartyView = Prisma.InviteGetPayload<{ select: typeof PARTY_INVITE_SELECT }>;

/** The row a transition works on. Internal to the lib. */
export type InviteTransitionRow = Prisma.InviteGetPayload<{ select: typeof TRANSITION_SELECT }>;
