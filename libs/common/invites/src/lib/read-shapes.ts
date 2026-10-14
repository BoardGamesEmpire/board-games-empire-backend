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
 * household (#297).
 *
 * A `select` shape inverts the default: a new column is invisible until someone
 * names it here. `read-shapes.spec.ts` enforces that by reading the model's
 * scalars out of the generated client, so a column added to `prisma/models`
 * fails the suite until it is classified as published, party-only, or withheld
 * (#297).
 *
 * ## Two audiences, two shapes
 *
 * {@link CONTEXT_INVITE_SELECT} is what a context reader sees: the household
 * detail embed, and whatever an owner or admin is shown. {@link
 * PARTY_INVITE_SELECT} is that plus the two columns that belong to the people
 * on the invite, `inviteeEmail` and `message`, rendered only on rows whose
 * inviter or invitee is the acting user (#459, option c). The lib's own
 * transitions return the party shape to a party and the context shape to a
 * context authority; a consumer listing invites for a context must not widen
 * to the party shape, since that re-opens #297's class for the address.
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
 * An invite as a context reader sees it (#297): the household detail embed, a
 * revoke or approve result.
 *
 * `role` is rendered as an object rather than the bare `roleId` the model
 * carries, so "invited as Admin" reads the same way a roster beside it renders
 * a member's role.
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
    'THE accept credential (`@unique`, "email confirmation token"). The context shape is reached by every holder of read:household — which includes non-members, via read:households:friends — and a party shape by the invitee it is meant for. Publishing it anywhere is an authorization bypass once accept is token-reachable (#163). Never select this.',
  inviterId: 'Superseded by the `inviter` relation above, which renders the user rather than an opaque id.',
  roleId: 'Superseded by the `role` relation above (#297).',
  inviteeId: 'Internal linkage. The invitee is identified to clients by `inviteeName`.',
  eventId: 'Not meaningful on a household read; an event invite reaches clients through the event routes.',
  householdId:
    'Redundant: a context read is nested under the context it belongs to, and a party already knows which invite they acted on.',
  metadata: 'Untyped internal payload for system invites (#161). Never a client contract.',
  needsApproval: 'Approval bookkeeping for #231; internal to the join-policy flow.',
  approvedById: 'Approval bookkeeping (#231). Same social-inference concern as `HouseholdMember.addedById`.',
  approvedAt: 'Approval bookkeeping (#231).',
  respondedAt: 'Lifecycle bookkeeping; `status` is the client-facing answer.',
  updatedAt: 'Row bookkeeping. `expiresAt` and `createdAt` are what a pending invite is judged by.',
  withheld:
    "Set when a block or the invitee's preference refused an invite by address (#278). The invite answers like any other so the inviter cannot tell, and any shape carrying this column would tell them. Only what delivers invites reads it, from the row.",
} as const satisfies Partial<Record<Prisma.InviteScalarFieldEnum, string>>;

/**
 * `Invite` scalars withheld from the context shape and published by the party
 * shape alone, and why (#161, answering #459 as its option c).
 */
export const INVITE_SCALARS_PARTY_ONLY = {
  inviteeEmail:
    'An address belonging to someone who may not be a registered user. Harvestable by every co-member under the old shape, and withheld from the context shape by #297. The inviter typed it and the invitee owns it, so each sees it on their own rows and nobody else does.',
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
