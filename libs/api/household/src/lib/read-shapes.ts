import { Prisma } from '@bge/database';

/**
 * Select-shaped read surfaces for the household routes.
 *
 * ## Why these are `select` and not `include`
 *
 * Prisma's `include:` means "every scalar column on the model, plus these
 * relations". The household controllers return service payloads directly —
 * there is no `ClassSerializerInterceptor` and no response DTO on the path — so
 * nothing downstream strips what the query over-fetched. Under `include:`,
 * every column added to a model is an implicit API change.
 *
 * That is not hypothetical. It published membership provenance when #276 added
 * `origin` and `addedById` (#296), and it published `Invite.token` — a live
 * accept credential — to every holder of `read:household`, which is every
 * member of the household (#297).
 *
 * A `select` shape inverts the default: a new column is invisible until someone
 * names it here. `read-shapes.spec.ts` enforces that by reading each model's
 * scalars out of the generated client, so a column added to `prisma/models`
 * fails the suite until it is classified as published or withheld (`D-297-5`).
 *
 * Fixing the query rather than adding a serializer is deliberate. A serializer
 * would still let the over-fetch cross the service boundary, and anything that
 * bypasses it — an internal caller, a raw handler, a future resolver — would be
 * exposed again.
 *
 * ## What this does NOT cover
 *
 * Exactly two models: `HouseholdMember` and `Invite`. The `Household` row that
 * carries them is still `include:`-shaped in `household.service.ts` — both the
 * detail read and `HOUSEHOLD_LIST_INCLUDE` — so a column added to `Household`
 * still reaches clients with this suite green. Nothing sensitive ships today
 * (`clientRequestId` is a per-creator idempotency key; `deletedAt` is filtered
 * to null on the read path), which is why it was left rather than folded in:
 * converting it changes the exported `HouseholdWithRelations` payload type and
 * every consumer of it. Tracked as a named candidate on #460.
 *
 * @see #296, #297, and #460 for the same class elsewhere in the tree.
 */

/**
 * How a person is rendered wherever a household read names one.
 *
 * Shared so the roster's `user` and an invite's `inviter` cannot drift into two
 * spellings of the same thing.
 */
const ACTOR_SELECT = {
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
 * The member roster surface (`D-296-5`).
 *
 * `householdId` is redundant on `GET /households/:householdId/members`, where
 * the caller already knows it, but load-bearing on the transfer-ownership and
 * role-change responses, which return rows a client may correlate without
 * tracking which request produced them.
 *
 * Intentionally lean in the other direction too: `excludedFromHouseholds` and
 * the sampled game-collection shaping are `HouseholdService.getHouseholdById`
 * presentation concerns, not part of the roster surface (#155). That read
 * composes them onto this shape rather than widening it for everyone.
 */
export const MEMBER_SELECT = {
  id: true,
  userId: true,
  householdId: true,
  showAllGames: true,
  createdAt: true,
  updatedAt: true,

  user: { select: ACTOR_SELECT },

  role: {
    select: {
      role: {
        select: { id: true, name: true },
      },
    },
  },
} as const satisfies Prisma.HouseholdMemberSelect;

/**
 * `HouseholdMember` scalars deliberately withheld from clients, and why.
 *
 * Adding a column to the model without adding it here or to
 * {@link MEMBER_SELECT} fails `read-shapes.spec.ts`. That failure is the point:
 * it forces the visibility of a new column to be decided once, deliberately,
 * rather than inherited from `include:` semantics.
 */
export const MEMBER_SCALARS_OMITTED = {
  origin:
    'Audit surface (#276). Nullable, where NULL means "created outside a consent path" — a tri-state a client should not have to model. Stripped by D-296-1.',
  addedById:
    'Audit surface (#276). Who-invited-whom is social information nobody decided to publish; it also undercuts the separation #278 is built to keep. Stripped by D-296-1.',
} as const satisfies Partial<Record<Prisma.HouseholdMemberScalarFieldEnum, string>>;

/**
 * Pending invites as they appear on the household detail view (`D-297-1`,
 * `D-297-6`).
 *
 * `role` is rendered as an object rather than the bare `roleId` the model
 * carries, so "invited as Admin" reads the same way the roster beside it
 * renders a member's role.
 */
export const PENDING_INVITE_SELECT = {
  id: true,
  status: true,
  type: true,
  inviteeName: true,
  expiresAt: true,
  createdAt: true,

  role: { select: { id: true, name: true } },

  inviter: { select: ACTOR_SELECT },
} as const satisfies Prisma.InviteSelect;

/**
 * `Invite` scalars deliberately withheld from clients, and why.
 *
 * The first two are the reason #297 exists; the rest are internal bookkeeping
 * that was only ever public because `include:` published it.
 */
export const INVITE_SCALARS_OMITTED = {
  token:
    'THE accept credential (`@unique`, "email confirmation token"). This shape is reached by every holder of read:household. Publishing it is an authorization bypass once accept is token-reachable (#163). Never select this.',
  inviteeEmail:
    'An address belonging to someone who may have no account. Harvestable by every co-member under the old shape. Withheld outright by D-297-2; whether the INVITER alone should see it is #459.',
  inviterId: 'Superseded by the `inviter` relation above, which renders the person rather than an opaque id.',
  roleId: 'Superseded by the `role` relation above (D-297-6).',
  inviteeId: 'Internal linkage. The invitee is identified to clients by `inviteeName`.',
  eventId: 'Not meaningful on a household read; an event invite reaches clients through the event routes.',
  householdId: 'Redundant — this shape is only ever nested under the household it belongs to.',
  // Not a response body: this key is the NAME of the `Invite.message` column,
  // and the string beside it is the reason the column is withheld. The i18n
  // rule (#144/#145) guards user-facing `message:` payloads; a ledger keyed by
  // column name is not one.
  // eslint-disable-next-line no-restricted-syntax
  message: 'Free text addressed to the invitee, not to the household at large.',
  metadata: 'Untyped internal payload for system invites (#161). Never a client contract.',
  needsApproval: 'Approval bookkeeping for #231; internal to the join-policy flow.',
  approvedById: 'Approval bookkeeping (#231). Same social-inference concern as `HouseholdMember.addedById`.',
  approvedAt: 'Approval bookkeeping (#231).',
  respondedAt: 'Lifecycle bookkeeping; `status` is the client-facing answer.',
  updatedAt: 'Row bookkeeping. `expiresAt` and `createdAt` are what a pending invite is judged by.',
} as const satisfies Partial<Record<Prisma.InviteScalarFieldEnum, string>>;
