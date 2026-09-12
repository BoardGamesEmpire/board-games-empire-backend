import type { Prisma } from '../client';
import { Action, ResourceType, RiskLevel } from '../client';
import { assertJsonConditions, assertUniqueSlugs, assertValidSubjects } from './catalog-integrity';
import type { CatalogSubject, DefinedPermission } from './permission-entry';
import { permission } from './permission-entry';

// Relational clause meaning "this User node is an accepted friend of the
// acting user". A friendship is a single directional row, so both directions
// must be checked. Rendered by the ability factory against `{{ user.id }}`
// and evaluated live against the friendship table at query time. Typed as the
// `User` where-clause it is spliced into (not `as const`: a readonly tuple is
// not a `UserWhereInput[]`), so its paths are checked like any entry's — and
// therefore module-private: that type is mutable, and the four entries below
// hold this one object by reference, so exporting it would hand a consumer a
// writable alias into shipped conditions the catalog presents as readonly.
const acceptedFriendOfActingUser = {
  OR: [
    { friendshipsRequested: { some: { addresseeId: '{{ user.id }}', status: 'Accepted' } } },
    { friendshipsReceived: { some: { requesterId: '{{ user.id }}', status: 'Accepted' } } },
  ],
} satisfies Prisma.UserWhereInput;

// An EventGame hangs off the event itself or off one of its occurrences
// (exactly one FK is set), so a grant bound to an event has to name both
// paths, and the household variant both paths' households. Typed as the
// `EventGame` where-clause they are spliced into and module-private, for the
// reasons `acceptedFriendOfActingUser` gives.
const eventGameInEvent = {
  OR: [{ eventId: '{{ eventId }}' }, { occurrence: { is: { eventId: '{{ eventId }}' } } }],
} satisfies Prisma.EventGameWhereInput;

const eventGameInHousehold = {
  OR: [
    { event: { is: { householdId: '{{ householdId }}' } } },
    { occurrence: { is: { event: { is: { householdId: '{{ householdId }}' } } } } },
  ],
} satisfies Prisma.EventGameWhereInput;

/**
 * The complete seeded permission catalog — the manifest of every permission
 * this code version expects to exist. Data, not behavior: the reconciler (#235) writes
 * it, the ability-factory specs import its real condition objects instead of
 * mirroring them (#155), and the validators (#234) and reconciler (#235) take
 * it as input.
 *
 * Every entry is written through `permission()`, which checks its
 * `conditions` paths and `fields` against the Prisma types of its own
 * `subject` as this file compiles (#234), and keeps `subject` and `slug`
 * literal so slugs stay a literal union (`PermissionSlug`) for downstream
 * consumers. The array's element type is what the builder returns, so an
 * entry written as a plain literal — and so never checked against its
 * subject — does not compile; a spread of a built entry with a member
 * overridden keeps that type and is a review matter (see
 * `DefinedPermission`). Consumers still read the array as
 * `readonly PermissionSeedDefinition[]`.
 */
export const PERMISSION_CATALOG = [
  // --- Global Admin/Owner ---
  permission({
    action: Action.manage,
    subject: 'all',
    slug: 'manage:all',
    riskLevel: RiskLevel.Critical,
    reason: 'Unrestricted access for Owner',
  }),
  permission({
    action: Action.manage,
    subject: 'all',
    slug: 'manage:content:moderate',
    riskLevel: RiskLevel.Critical,
    reason: 'Moderate app content',
  }),
  permission({
    action: Action.read,
    subject: 'all',
    slug: 'read:public_content',
    riskLevel: RiskLevel.Low,
    reason: 'View public content',
  }),

  // --- App Level / User ---
  // TODO: consider the ability to block other users from viewing your profile, etc.
  permission({
    action: Action.read,
    subject: ResourceType.UserProfile,
    slug: 'read:user:profile',
    riskLevel: RiskLevel.High,
    reason: 'View user profiles',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.UserProfile,
    conditions: { userId: '{{ user.id }}' },
    slug: 'update:user:profile:own',
    riskLevel: RiskLevel.Low,
    reason: 'Update own profile',
  }),

  // --- Friendships ---
  // Self-management: the acting user is a participant (requester or addressee).
  permission({
    action: Action.create,
    subject: ResourceType.Friendship,
    conditions: { requesterId: '{{ user.id }}' },
    slug: 'create:friendship',
    riskLevel: RiskLevel.Low,
    reason: 'Send a friend request',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.Friendship,
    conditions: { OR: [{ requesterId: '{{ user.id }}' }, { addresseeId: '{{ user.id }}' }] },
    slug: 'read:friendships:own',
    riskLevel: RiskLevel.Low,
    reason: 'View your own friendships and requests',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.Friendship,
    conditions: { OR: [{ requesterId: '{{ user.id }}' }, { addresseeId: '{{ user.id }}' }] },
    slug: 'update:friendship:own',
    riskLevel: RiskLevel.Low,
    reason: 'Respond to, withdraw, or block a friendship you are part of',
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.Friendship,
    conditions: { OR: [{ requesterId: '{{ user.id }}' }, { addresseeId: '{{ user.id }}' }] },
    slug: 'delete:friendship:own',
    riskLevel: RiskLevel.Low,
    reason: 'Remove a friendship you are part of',
  }),
  // Friend visibility: read resources exposed to friends by their owner.
  permission({
    action: Action.read,
    subject: ResourceType.Event,
    conditions: { visibility: 'Friends', createdBy: acceptedFriendOfActingUser },
    slug: 'read:event:friends',
    riskLevel: RiskLevel.Medium,
    reason: "View a friend's friends-visible events",
  }),
  permission({
    action: Action.read,
    subject: ResourceType.Household,
    conditions: { visibility: 'Friends', members: { some: { user: acceptedFriendOfActingUser } } },
    slug: 'read:households:friends',
    riskLevel: RiskLevel.Medium,
    reason: "View a friend's friends-visible households",
  }),

  // --- Games ---
  permission({
    action: Action.read,
    subject: ResourceType.Game,
    slug: 'read:game',
    riskLevel: RiskLevel.Low,
    reason: 'View games',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.Job,
    slug: 'read:job',
    riskLevel: RiskLevel.Medium,
    reason: 'View import/system job status',
  }),
  permission({
    action: Action.create,
    subject: ResourceType.Game,
    slug: 'create:game',
    riskLevel: RiskLevel.Low,
    reason: 'Create games',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.Game,
    slug: 'update:game',
    riskLevel: RiskLevel.High,
    reason: 'Update games',
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.Game,
    slug: 'delete:game',
    riskLevel: RiskLevel.High,
    reason: 'Delete games',
  }),

  permission({
    action: Action.update,
    subject: ResourceType.Game,
    slug: 'update:game:own',
    riskLevel: RiskLevel.Low,
    reason: 'Update own games',
    conditions: { createdById: '{{ user.id }}' },
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.Game,
    slug: 'delete:game:own',
    riskLevel: RiskLevel.Low,
    reason: 'Delete own games',
    conditions: { createdById: '{{ user.id }}' },
  }),

  // --- PlatformGame ---
  permission({
    action: Action.read,
    subject: ResourceType.PlatformGame,
    slug: 'read:platform_game',
    riskLevel: RiskLevel.Low,
    reason: 'View platform-specific game entries',
  }),
  permission({
    action: Action.create,
    subject: ResourceType.PlatformGame,
    slug: 'create:platform_game',
    riskLevel: RiskLevel.Medium,
    reason: 'Create a platform-specific game entry (import pipelines)',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.PlatformGame,
    slug: 'update:platform_game',
    riskLevel: RiskLevel.Medium,
    reason: 'Update platform-specific game capabilities or overrides',
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.PlatformGame,
    slug: 'delete:platform_game',
    riskLevel: RiskLevel.Medium,
    reason: 'Remove a platform-specific game entry',
  }),

  // --- Platform ---
  permission({
    action: Action.read,
    subject: ResourceType.Platform,
    slug: 'read:platform',
    riskLevel: RiskLevel.Low,
    reason: 'View platforms',
  }),
  permission({
    action: Action.create,
    subject: ResourceType.Platform,
    slug: 'create:platform',
    riskLevel: RiskLevel.Medium,
    reason: 'Create platforms',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.Platform,
    slug: 'update:platform',
    riskLevel: RiskLevel.Medium,
    reason: 'Update platforms',
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.Platform,
    slug: 'delete:platform',
    riskLevel: RiskLevel.Medium,
    reason: 'Delete platforms',
  }),

  // ─── EventOccurrence ────────────────────────────────
  //
  // Event sub-resource grants bind to the coordinate the pass rendering them
  // supplies. An event role renders with `{{ eventId }}`, so an event-bound
  // grant names the row's event: the scalar `eventId` where the subject
  // carries one, a relation traversal where it does not. Left unconditioned,
  // these grants reached every row in the install for anyone holding any
  // event or household role (#432).
  //
  // A household role renders with `{{ householdId }}` and never `{{ eventId }}`,
  // so it holds a `:household` variant of each operation instead, bound
  // through the event's household; an event with no household is out of every
  // household role's reach (#436). The event-bound original stays with the
  // event roles.
  //
  // These grants write relation traversals in Prisma's operator form (`is`,
  // `some`), not the `{ relation: { field } }` shorthand. Prisma accepts both in a
  // query, but the in-memory matcher behind `ability.can(action, subject(...))`
  // accepts only the operator form and throws on the shorthand — and the
  // create paths run exactly that check. A create has no row for a query
  // filter to bind, and `@CheckPolicies` judges a create by type alone, so
  // the service checks a subject built from the request and its parent row
  // before writing.
  permission({
    action: Action.read,
    subject: ResourceType.EventOccurrence,
    conditions: { eventId: '{{ eventId }}' },
    slug: 'read:event_occurrence',
    riskLevel: RiskLevel.Medium,
    reason: 'View event occurrences',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.EventOccurrence,
    conditions: { event: { is: { householdId: '{{ householdId }}' } } },
    slug: 'read:event_occurrence:household',
    riskLevel: RiskLevel.Medium,
    reason: "View the occurrences of your household's events",
  }),
  permission({
    action: Action.create,
    subject: ResourceType.EventOccurrence,
    conditions: { eventId: '{{ eventId }}' },
    slug: 'create:event_occurrence',
    riskLevel: RiskLevel.Medium,
    reason: 'Add occurrences to an event',
  }),
  permission({
    action: Action.create,
    subject: ResourceType.EventOccurrence,
    conditions: { event: { is: { householdId: '{{ householdId }}' } } },
    slug: 'create:event_occurrence:household',
    riskLevel: RiskLevel.Medium,
    reason: "Add occurrences to your household's events",
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventOccurrence,
    conditions: { eventId: '{{ eventId }}' },
    slug: 'update:event_occurrence',
    riskLevel: RiskLevel.Medium,
    reason: 'Update occurrence details (label, date, location)',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventOccurrence,
    conditions: { event: { is: { householdId: '{{ householdId }}' } } },
    slug: 'update:event_occurrence:household',
    riskLevel: RiskLevel.Medium,
    reason: "Update occurrence details on your household's events",
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.EventOccurrence,
    conditions: { eventId: '{{ eventId }}' },
    slug: 'delete:event_occurrence',
    riskLevel: RiskLevel.Medium,
    reason: 'Remove an occurrence from an event',
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.EventOccurrence,
    conditions: { event: { is: { householdId: '{{ householdId }}' } } },
    slug: 'delete:event_occurrence:household',
    riskLevel: RiskLevel.Medium,
    reason: "Remove an occurrence from your household's events",
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventOccurrence,
    conditions: { eventId: '{{ eventId }}' },
    slug: 'update:event_occurrence:confirm',
    riskLevel: RiskLevel.Medium,
    reason: 'Confirm a proposed occurrence (Proposed → Confirmed)',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventOccurrence,
    conditions: { event: { is: { householdId: '{{ householdId }}' } } },
    slug: 'update:event_occurrence:confirm:household',
    riskLevel: RiskLevel.Medium,
    reason: "Confirm a proposed occurrence on your household's events",
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventOccurrence,
    conditions: { eventId: '{{ eventId }}' },
    slug: 'update:event_occurrence:decline',
    riskLevel: RiskLevel.Medium,
    reason: 'Decline a proposed occurrence (Proposed → Declined)',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventOccurrence,
    conditions: { event: { is: { householdId: '{{ householdId }}' } } },
    slug: 'update:event_occurrence:decline:household',
    riskLevel: RiskLevel.Medium,
    reason: "Decline a proposed occurrence on your household's events",
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventOccurrence,
    conditions: { eventId: '{{ eventId }}' },
    slug: 'update:event_occurrence:cancel',
    riskLevel: RiskLevel.Medium,
    reason: 'Cancel a confirmed occurrence (Confirmed → Cancelled)',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventOccurrence,
    conditions: { event: { is: { householdId: '{{ householdId }}' } } },
    slug: 'update:event_occurrence:cancel:household',
    riskLevel: RiskLevel.Medium,
    reason: "Cancel a confirmed occurrence on your household's events",
  }),

  // ─── EventAvailabilityVote ──────────────────────────
  permission({
    action: Action.read,
    subject: ResourceType.EventAvailabilityVote,
    conditions: { occurrence: { is: { eventId: '{{ eventId }}' } } },
    slug: 'read:event_availability_vote',
    riskLevel: RiskLevel.Medium,
    reason: 'View availability votes and summary',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.EventAvailabilityVote,
    conditions: { occurrence: { is: { event: { is: { householdId: '{{ householdId }}' } } } } },
    slug: 'read:event_availability_vote:household',
    riskLevel: RiskLevel.Medium,
    reason: "View availability votes on your household's events",
  }),
  permission({
    action: Action.create,
    subject: ResourceType.EventAvailabilityVote,
    conditions: { attendee: { userId: '{{ user.id }}' } },
    slug: 'create:event_availability_vote',
    riskLevel: RiskLevel.Low,
    reason: 'Submit or update your availability vote on a proposed occurrence',
  }),

  // ─── EventAttendee ──────────────────────────────────
  permission({
    action: Action.read,
    subject: ResourceType.EventAttendee,
    conditions: { event: { id: '{{ eventId }}' } },
    slug: 'read:event_attendee',
    riskLevel: RiskLevel.Medium,
    reason: 'View event attendees',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.EventAttendee,
    conditions: { event: { is: { householdId: '{{ householdId }}' } } },
    slug: 'read:event_attendee:household',
    riskLevel: RiskLevel.Medium,
    reason: "View the attendees of your household's events",
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventAttendee,
    fields: ['status', 'notes'],
    conditions: { userId: '{{ user.id }}' },
    slug: 'update:event_attendee:status:self',
    riskLevel: RiskLevel.Low,
    reason: 'Update own RSVP status',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventAttendee,
    fields: ['status', 'notes'],
    conditions: { event: { id: '{{ eventId }}' } },
    slug: 'update:event_attendee:status',
    riskLevel: RiskLevel.Medium,
    reason: 'Update any attendee status within an event (host-managed)',
  }),

  // ─── EventGameNomination ────────────────────────────
  permission({
    action: Action.read,
    subject: ResourceType.EventGameNomination,
    conditions: { eventId: '{{ eventId }}' },
    slug: 'read:event_game_nomination',
    riskLevel: RiskLevel.Medium,
    reason: 'View game nominations',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.EventGameNomination,
    conditions: { event: { is: { householdId: '{{ householdId }}' } } },
    slug: 'read:event_game_nomination:household',
    riskLevel: RiskLevel.Medium,
    reason: "View game nominations on your household's events",
  }),
  permission({
    action: Action.create,
    subject: ResourceType.EventGameNomination,
    conditions: { eventId: '{{ eventId }}' },
    slug: 'create:event_game_nomination',
    riskLevel: RiskLevel.Low,
    reason: 'Nominate a game for the event',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventGameNomination,
    conditions: { nominatedBy: { userId: '{{ user.id }}' } },
    slug: 'update:event_game_nomination:withdraw',
    riskLevel: RiskLevel.Low,
    reason: 'Withdraw your own nomination',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventGameNomination,
    conditions: { eventId: '{{ eventId }}' },
    slug: 'update:event_game_nomination:resolve',
    riskLevel: RiskLevel.Medium,
    reason: 'Resolve a nomination (tally votes)',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventGameNomination,
    conditions: { event: { is: { householdId: '{{ householdId }}' } } },
    slug: 'update:event_game_nomination:resolve:household',
    riskLevel: RiskLevel.Medium,
    reason: "Resolve a nomination on your household's events",
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventGameNomination,
    conditions: { eventId: '{{ eventId }}' },
    slug: 'update:event_game_nomination:approve',
    riskLevel: RiskLevel.Medium,
    reason: 'Approve a nomination (HostApproval mode)',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventGameNomination,
    conditions: { eventId: '{{ eventId }}' },
    slug: 'update:event_game_nomination:reject',
    riskLevel: RiskLevel.Medium,
    reason: 'Reject a nomination (HostApproval mode)',
  }),

  // ─── EventGameVote ──────────────────────────────────
  permission({
    action: Action.read,
    subject: ResourceType.EventGameVote,
    conditions: { nomination: { is: { eventId: '{{ eventId }}' } } },
    slug: 'read:event_game_vote',
    riskLevel: RiskLevel.Medium,
    reason: 'View game nomination votes',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.EventGameVote,
    conditions: { nomination: { is: { event: { is: { householdId: '{{ householdId }}' } } } } },
    slug: 'read:event_game_vote:household',
    riskLevel: RiskLevel.Medium,
    reason: "View game nomination votes on your household's events",
  }),
  permission({
    action: Action.create,
    subject: ResourceType.EventGameVote,
    conditions: { attendee: { userId: '{{ user.id }}' } },
    slug: 'create:event_game_vote',
    riskLevel: RiskLevel.Low,
    reason: 'Cast or update your vote on a nomination',
  }),

  // ─── EventGame ──────────────────────────────────────
  // Both parents are named in every grant; `eventGameInEvent` and
  // `eventGameInHousehold` at the top of the file say why.
  permission({
    action: Action.read,
    subject: ResourceType.EventGame,
    conditions: eventGameInEvent,
    slug: 'read:event_game',
    riskLevel: RiskLevel.Low,
    reason: 'View the event game lineup',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.EventGame,
    conditions: eventGameInHousehold,
    slug: 'read:event_game:household',
    riskLevel: RiskLevel.Low,
    reason: "View the game lineup of your household's events",
  }),
  permission({
    action: Action.create,
    subject: ResourceType.EventGame,
    conditions: eventGameInEvent,
    slug: 'create:event_game',
    riskLevel: RiskLevel.Medium,
    reason: 'Directly add a game to the event lineup',
  }),
  permission({
    action: Action.create,
    subject: ResourceType.EventGame,
    conditions: eventGameInHousehold,
    slug: 'create:event_game:household',
    riskLevel: RiskLevel.Medium,
    reason: "Directly add a game to the lineup of your household's events",
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.EventGame,
    conditions: eventGameInEvent,
    slug: 'delete:event_game',
    riskLevel: RiskLevel.Medium,
    reason: 'Remove a game from the event lineup',
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.EventGame,
    conditions: eventGameInHousehold,
    slug: 'delete:event_game:household',
    riskLevel: RiskLevel.Medium,
    reason: "Remove a game from the lineup of your household's events",
  }),

  // ─── EventAttendeeGameList ──────────────────────────
  permission({
    action: Action.read,
    subject: ResourceType.EventAttendeeGameList,
    conditions: { attendee: { is: { eventId: '{{ eventId }}' } } },
    slug: 'read:attendee_game_list',
    riskLevel: RiskLevel.Medium,
    reason: "View an attendee's available game list",
  }),
  permission({
    action: Action.read,
    subject: ResourceType.EventAttendeeGameList,
    conditions: { attendee: { is: { event: { is: { householdId: '{{ householdId }}' } } } } },
    slug: 'read:attendee_game_list:household',
    riskLevel: RiskLevel.Medium,
    reason: "View the available game lists of your household's events",
  }),
  // The own-list pair is in operator form too: the game-list create path
  // checks `create:attendee_game_list` against an instance (a participant may
  // add to their own list, a manager to any list in the event), and the
  // matcher throws on the shorthand this pair used to carry. The delete
  // mirrors the create so the pair reads alike.
  permission({
    action: Action.create,
    subject: ResourceType.EventAttendeeGameList,
    conditions: { attendee: { is: { userId: '{{ user.id }}' } } },
    slug: 'create:attendee_game_list',
    riskLevel: RiskLevel.Low,
    reason: 'Add a game to your own available game list',
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.EventAttendeeGameList,
    conditions: { attendee: { is: { userId: '{{ user.id }}' } } },
    slug: 'delete:attendee_game_list',
    riskLevel: RiskLevel.Low,
    reason: 'Remove a game from your own available game list',
  }),
  permission({
    action: Action.manage,
    subject: ResourceType.EventAttendeeGameList,
    conditions: { attendee: { is: { eventId: '{{ eventId }}' } } },
    slug: 'manage:attendee_game_list',
    riskLevel: RiskLevel.Medium,
    reason: "Manage any attendee's available game list",
  }),
  permission({
    action: Action.manage,
    subject: ResourceType.EventAttendeeGameList,
    conditions: { attendee: { is: { event: { is: { householdId: '{{ householdId }}' } } } } },
    slug: 'manage:attendee_game_list:household',
    riskLevel: RiskLevel.Medium,
    reason: "Manage any attendee's available game list on your household's events",
  }),

  // ─── EventPolicy ────────────────────────────────────
  permission({
    action: Action.read,
    subject: ResourceType.EventPolicy,
    conditions: { eventId: '{{ eventId }}' },
    slug: 'read:event_policy',
    riskLevel: RiskLevel.Low,
    reason: 'View event policy configuration',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.EventPolicy,
    conditions: { event: { is: { householdId: '{{ householdId }}' } } },
    slug: 'read:event_policy:household',
    riskLevel: RiskLevel.Low,
    reason: "View the policy configuration of your household's events",
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventPolicy,
    conditions: { eventId: '{{ eventId }}' },
    slug: 'update:event_policy',
    riskLevel: RiskLevel.Medium,
    reason: 'Update event policy configuration',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.EventPolicy,
    conditions: { event: { is: { householdId: '{{ householdId }}' } } },
    slug: 'update:event_policy:household',
    riskLevel: RiskLevel.Medium,
    reason: "Update the policy configuration of your household's events",
  }),

  // Game Collection
  //
  // Read access is a union of scoped grants (CASL `can` rules on the same
  // action+subject OR together): own rows (tombstones included, for the
  // "previously owned" view), household-shared, friend-shared, and public.
  // The shared scopes never expose tombstoned rows.
  //
  // NOTE: `read:game_collection` was previously unconditioned — any holder
  // (household/event roles included) could read EVERY user's collection.
  // It is now own-rows-only by design. Household/event surfaces read member
  // collections through their own queries (household game view, attendee
  // game lists), not through this grant, and cross-user API reads flow
  // through the :household/:friends/:public scopes on the base User role.
  // Moderators keep full read via `manage:content:moderate` (subject 'all').
  permission({
    action: Action.read,
    subject: ResourceType.GameCollection,
    conditions: { userId: '{{ user.id }}' },
    slug: 'read:game_collection',
    riskLevel: RiskLevel.Low,
    reason: 'View your own game collection',
  }),
  // Row visible when the owner shares a household with the acting user, the
  // owner's membership in that household has `showAllGames`, the row is not
  // excluded from a household the acting user belongs to, and the row's
  // visibility admits household viewers.
  //
  // Known approximation: `showAllGames` and the ExcludedGame check cannot be
  // correlated to the *same* shared household from inside this flat Prisma
  // clause — when owner and viewer share 2+ households with differing
  // exclusions/flags, an exclusion in any shared household hides the row.
  permission({
    action: Action.read,
    subject: ResourceType.GameCollection,
    conditions: {
      deletedAt: null,
      visibility: { in: ['Household', 'Friends', 'FriendsOfFriends', 'Public'] },
      user: {
        householdMember: {
          some: {
            showAllGames: true,
            household: { members: { some: { userId: '{{ user.id }}' } } },
          },
        },
      },
      excludedFromHouseholds: {
        none: {
          householdMember: { household: { members: { some: { userId: '{{ user.id }}' } } } },
        },
      },
    },
    slug: 'read:game_collection:household',
    riskLevel: RiskLevel.Medium,
    reason: 'View collections shared with your household',
  }),
  // Row visible to accepted friends of the owner when the owner's
  // preferences allow it (absent preferences row → schema default `true`,
  // mirroring FriendshipService). FriendsOfFriends currently grants to
  // direct friends only — 2-hop traversal is deferred.
  permission({
    action: Action.read,
    subject: ResourceType.GameCollection,
    conditions: {
      deletedAt: null,
      visibility: { in: ['Friends', 'FriendsOfFriends', 'Public'] },
      user: {
        AND: [
          { OR: [{ preferences: { is: null } }, { preferences: { showCollectionToFriends: true } }] },
          acceptedFriendOfActingUser,
        ],
      },
    },
    slug: 'read:game_collection:friends',
    riskLevel: RiskLevel.Medium,
    reason: "View your friends' collections",
  }),
  permission({
    action: Action.read,
    subject: ResourceType.GameCollection,
    conditions: { deletedAt: null, visibility: 'Public' },
    slug: 'read:game_collection:public',
    riskLevel: RiskLevel.Low,
    reason: 'View public collections',
  }),
  permission({
    action: Action.create,
    subject: ResourceType.GameCollection,
    conditions: { userId: '{{ user.id }}' },
    slug: 'create:game_collection',
    riskLevel: RiskLevel.Low,
    reason: 'Add game to collection',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.GameCollection,
    conditions: { userId: '{{ user.id }}' },
    slug: 'update:game_collection',
    riskLevel: RiskLevel.Low,
    reason: 'Update game in collection',
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.GameCollection,
    conditions: { userId: '{{ user.id }}' },
    slug: 'delete:game_collection',
    riskLevel: RiskLevel.Low,
    reason: 'Remove game from collection',
  }),

  // --- Game Gateway ---
  permission({
    action: Action.read,
    subject: ResourceType.GameGateway,
    slug: 'read:game_gateway',
    riskLevel: RiskLevel.High,
    reason: 'View game gateway connections',
  }),
  permission({
    action: Action.create,
    subject: ResourceType.GameGateway,
    slug: 'create:game_gateway',
    riskLevel: RiskLevel.High,
    reason: 'Create game gateway connections',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.GameGateway,
    slug: 'update:game_gateway',
    riskLevel: RiskLevel.High,
    reason: 'Update game gateway connections',
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.GameGateway,
    slug: 'delete:game_gateway',
    riskLevel: RiskLevel.High,
    reason: 'Delete game gateway connections',
  }),

  // --- Households ---
  permission({
    action: Action.create,
    subject: ResourceType.Household,
    slug: 'create:household',
    riskLevel: RiskLevel.Low,
    reason: 'Create a household',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.Household,
    conditions: {
      members: { some: { userId: '{{ user.id }}' } },
    },
    slug: 'read:households',
    riskLevel: RiskLevel.Low,
    reason: 'View households',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.Household,
    conditions: {
      id: '{{ householdId }}',
    },
    slug: 'read:household',
    riskLevel: RiskLevel.Low,
    reason: 'View household details',
  }),

  // Owner/Admin only, matching `delete:household` and `manage:household_member`.
  //
  // The prior condition asked only for membership. That was never as bad as
  // the removed TODO claimed ("any member could update the household") —
  // the slug is assigned exclusively to HouseholdOwner/HouseholdAdmin, and
  // `{{ householdId }}` renders per membership, so a plain member never
  // received the rule at all. The defect was that the condition depended on
  // the assignment list for its entire security value: grant the slug one
  // role wider and it silently becomes membership-only. The role clause
  // makes the constraint self-describing (#160).
  permission({
    action: Action.update,
    subject: ResourceType.Household,
    conditions: {
      id: '{{ householdId }}',
      members: {
        some: {
          userId: '{{ user.id }}',
          role: { role: { name: { in: ['HouseholdOwner', 'HouseholdAdmin'] } } },
        },
      },
    },
    slug: 'update:household',
    riskLevel: RiskLevel.Low,
    reason: 'Update a household',
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.Household,
    conditions: {
      id: '{{ householdId }}',
      members: {
        some: {
          userId: '{{ user.id }}',
          role: { role: { name: 'HouseholdOwner' } },
        },
      },
    },
    slug: 'delete:household',
    riskLevel: RiskLevel.Medium,
    reason: 'Delete a household',
  }),
  permission({
    action: Action.manage,
    subject: ResourceType.HouseholdMember,
    conditions: {
      householdId: '{{ householdId }}',
      // Defense-in-depth only: the `{{ householdId }}` pin already scopes to
      // households where the actor holds the granting role. The relation path
      // must go through `household` — HouseholdMember has no `members` field.
      household: {
        members: {
          some: {
            userId: '{{ user.id }}',
            role: { role: { name: { in: ['HouseholdOwner', 'HouseholdAdmin'] } } },
          },
        },
      },
    },
    slug: 'manage:household_member',
    riskLevel: RiskLevel.High,
    reason: 'Manage household members',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.HouseholdMember,
    conditions: { householdId: '{{ householdId }}' },
    slug: 'read:household_member',
    riskLevel: RiskLevel.Low,
    reason: 'View the member roster of a household you belong to',
  }),
  // Roster readability follows household readability: a friend can already
  // read the full member list through getHouseholdById's embed under
  // read:households:friends, so the sub-resource grants the same visibility.
  permission({
    action: Action.read,
    subject: ResourceType.HouseholdMember,
    conditions: {
      household: { visibility: 'Friends', members: { some: { user: acceptedFriendOfActingUser } } },
    },
    slug: 'read:household_member:friends',
    riskLevel: RiskLevel.Medium,
    reason: "View the member roster of a friend's friends-visible household",
  }),
  // Self-scoped by conditions: the `userId` pin means every household role
  // can hold this grant without conferring removal power over anyone else.
  // The service additionally pins `userId` in its `where` because CASL
  // `manage` implies `delete` — an Owner/Admin's delete conditions cover the
  // whole roster, and "leave" must mean the acting user's own row.
  permission({
    action: Action.delete,
    subject: ResourceType.HouseholdMember,
    conditions: {
      userId: '{{ user.id }}',
      householdId: '{{ householdId }}',
    },
    slug: 'delete:household_member:leave',
    riskLevel: RiskLevel.Low,
    reason: 'Leave a household you belong to',
  }),
  permission({
    action: Action.create,
    subject: ResourceType.HouseholdRole,
    conditions: {
      // HouseholdRole carries neither `householdId` nor `members` — the only
      // path to the household is through its 1:1 member row.
      householdMember: {
        household: {
          members: {
            some: {
              userId: '{{ user.id }}',
              role: { role: { name: { in: ['HouseholdOwner', 'HouseholdAdmin'] } } },
            },
          },
        },
      },
    },
    slug: 'create:household_role',
    riskLevel: RiskLevel.High,
    reason: 'Create household roles',
  }),
  // The Owner-only gate for transfer-ownership (#158).
  //
  // Subject is HouseholdRole rather than Household on purpose. A transfer IS
  // two HouseholdRole writes, and more practically: Household + `update` can
  // never express "Owner only", because `update:household` is held by
  // HouseholdAdmin too and `accessibleBy` UNIONS every matching rule for an
  // (action, subject) pair — a narrower rule widens the OR, it cannot
  // restrict it. HouseholdRole carries no other `update`/`manage` grant, so
  // `can(update, HouseholdRole)` is exactly "is an owner of some household".
  //
  // INVARIANT: `update`/`manage` on HouseholdRole must never be granted to
  // HouseholdAdmin — see `HOUSEHOLD_OWNER_ONLY` in role-permission.catalog.ts,
  // which withholds this slug from the derived HouseholdAdmin list. #234's
  // walker is where this becomes machine-checked.
  permission({
    action: Action.update,
    subject: ResourceType.HouseholdRole,
    conditions: {
      // Same traversal as `create:household_role`: HouseholdRole carries
      // neither `householdId` nor `members`, so the household is reachable
      // only through the 1:1 member row.
      householdMember: {
        household: {
          id: '{{ householdId }}',
          members: {
            some: {
              userId: '{{ user.id }}',
              role: { role: { name: 'HouseholdOwner' } },
            },
          },
        },
      },
    },
    slug: 'update:household_role:transfer-ownership',
    riskLevel: RiskLevel.High,
    reason: 'Transfer household ownership to another member',
  }),

  // TODO: maybe defer to a household policy?
  permission({
    action: Action.create,
    subject: ResourceType.Invite,
    conditions: {
      householdId: '{{ householdId }}',
      household: {
        members: {
          some: {
            userId: '{{ user.id }}',
            role: { role: { name: { in: ['HouseholdOwner', 'HouseholdAdmin'] } } },
          },
        },
      },
    },
    slug: 'create:household_invite',
    riskLevel: RiskLevel.Medium,
    reason: 'Invite to household',
  }),

  // TODO: this is likely too simplistic
  permission({
    action: Action.create,
    subject: ResourceType.HouseholdMember,
    conditions: {
      householdId: '{{ householdId }}',
    },
    slug: 'create:household_member:join',
    riskLevel: RiskLevel.Medium,
    reason: 'Join household',
  }),

  // --- Events ---
  permission({
    action: Action.create,
    subject: ResourceType.Event,
    slug: 'create:event',
    riskLevel: RiskLevel.Low,
    reason: 'Create an event',
  }),

  // TODO household specific event permissions? i.e read:household_event etc
  permission({
    action: Action.read,
    subject: ResourceType.Event,
    slug: 'read:event',
    riskLevel: RiskLevel.High,
    reason: 'View any event (moderation/admin)',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.Event,
    conditions: {
      id: '{{ eventId }}',
      attendees: { some: { userId: '{{ user.id }}' } },
    },
    slug: 'read:event:participant',
    riskLevel: RiskLevel.Low,
    reason: 'View an event you attend',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.Event,
    conditions: { householdId: '{{ householdId }}' },
    slug: 'read:event:participant:household',
    riskLevel: RiskLevel.Low,
    reason: "View your household's events",
  }),
  permission({
    action: Action.update,
    subject: ResourceType.Event,
    conditions: {
      id: '{{ eventId }}',
      attendees: {
        some: {
          userId: '{{ user.id }}',
          role: { role: { name: { in: ['EventHost', 'EventCoHost', 'EventOrganizer', 'EventModerator'] } } },
        },
      },
    },
    slug: 'update:event',
    riskLevel: RiskLevel.Low,
    reason: 'Update an event',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.Event,
    conditions: { householdId: '{{ householdId }}' },
    slug: 'update:event:household',
    riskLevel: RiskLevel.Low,
    reason: "Update your household's events",
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.Event,
    conditions: { createdById: '{{ user.id }}' },
    slug: 'delete:event',
    riskLevel: RiskLevel.Low,
    reason: 'Delete an event as creator',
  }),

  // TODO: this needs conditions to validate moderator role and scope
  permission({
    action: Action.delete,
    subject: ResourceType.Event,
    slug: 'delete:event:moderate',
    riskLevel: RiskLevel.High,
    reason: 'Delete any event as moderator',
  }),

  // TODO: this doesn't actually ensure the event is being cancelled...
  permission({
    action: Action.update,
    subject: ResourceType.Event,
    fields: ['status'],
    conditions: {
      id: '{{ eventId }}',
      attendees: {
        some: {
          userId: '{{ user.id }}',
          role: { role: { name: { in: ['EventHost', 'EventCoHost'] } } },
        },
      },
    },
    slug: 'update:event:status:cancel-event',
    riskLevel: RiskLevel.Low,
    reason: 'Cancel an event',
  }),

  // An event can be archived if it is cancelled and the user is the host
  permission({
    action: Action.update,
    subject: ResourceType.Event,
    fields: ['status'],
    conditions: {
      id: '{{ eventId }}',
      status: 'Cancelled',
      attendees: {
        some: {
          userId: '{{ user.id }}',
          role: { role: { name: 'EventHost' } },
        },
      },
    },
    slug: 'update:event:status:archive-event',
    riskLevel: RiskLevel.Low,
    reason: 'Archive a cancelled event',
  }),
  permission({
    action: Action.create,
    subject: ResourceType.Invite,
    conditions: {
      eventId: '{{ eventId }}',
      event: {
        attendees: {
          some: {
            userId: '{{ user.id }}',
            role: { role: { name: { in: ['EventHost', 'EventCoHost', 'EventOrganizer', 'EventParticipant'] } } },
          },
        },
      },
    },
    slug: 'create:event_invite',
    riskLevel: RiskLevel.Low,
    reason: 'Invite to event',
  }),
  permission({
    action: Action.create,
    subject: ResourceType.Invite,
    conditions: { event: { is: { householdId: '{{ householdId }}' } } },
    slug: 'create:event_invite:household',
    riskLevel: RiskLevel.Low,
    reason: "Invite to your household's events",
  }),
  permission({
    action: Action.manage,
    subject: ResourceType.EventAttendee,
    conditions: { eventId: '{{ eventId }}' },
    slug: 'manage:event_attendee',
    riskLevel: RiskLevel.Medium,
    reason: 'Manage event participants',
  }),
  permission({
    action: Action.manage,
    subject: ResourceType.EventAttendee,
    conditions: { event: { is: { householdId: '{{ householdId }}' } } },
    slug: 'manage:event_attendee:household',
    riskLevel: RiskLevel.Medium,
    reason: "Manage the participants of your household's events",
  }),

  // --- Game Sessions ---
  // A session reaches an event only through its optional occurrence, so a
  // session outside any occurrence is out of every event role's reach; the
  // `:household` variants bind on the session's own `householdId`.
  // `read:game_play_session` and `create:session_player:join` stay
  // unconditioned on purpose: plain `User` holds them, so global reach is
  // intended, not an oversight.
  permission({
    action: Action.create,
    subject: ResourceType.GamePlayResult,
    conditions: { gamePlaySession: { is: { occurrence: { is: { eventId: '{{ eventId }}' } } } } },
    slug: 'create:play_record',
    riskLevel: RiskLevel.Low,
    reason: 'Create a play record',
  }),
  permission({
    action: Action.create,
    subject: ResourceType.GamePlayResult,
    conditions: { gamePlaySession: { is: { householdId: '{{ householdId }}' } } },
    slug: 'create:play_record:household',
    riskLevel: RiskLevel.Low,
    reason: "Create a play record for your household's sessions",
  }),
  permission({
    action: Action.read,
    subject: ResourceType.GamePlaySession,
    slug: 'read:game_play_session',
    riskLevel: RiskLevel.Medium,
    reason: 'View a game session',
  }),
  permission({
    action: Action.create,
    subject: ResourceType.GamePlaySession,
    conditions: { occurrence: { is: { eventId: '{{ eventId }}' } } },
    slug: 'create:game_play_session',
    riskLevel: RiskLevel.Low,
    reason: 'Create a game session',
  }),
  permission({
    action: Action.create,
    subject: ResourceType.GamePlaySession,
    conditions: { householdId: '{{ householdId }}' },
    slug: 'create:game_play_session:household',
    riskLevel: RiskLevel.Low,
    reason: 'Create a game session for your household',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.GamePlaySession,
    conditions: { occurrence: { is: { eventId: '{{ eventId }}' } } },
    slug: 'update:game_play_session',
    riskLevel: RiskLevel.Medium,
    reason: 'Update a game session',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.GamePlaySession,
    conditions: { householdId: '{{ householdId }}' },
    slug: 'update:game_play_session:household',
    riskLevel: RiskLevel.Medium,
    reason: "Update your household's game sessions",
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.GamePlaySession,
    conditions: { occurrence: { is: { eventId: '{{ eventId }}' } } },
    slug: 'delete:game_play_session',
    riskLevel: RiskLevel.Medium,
    reason: 'Delete a game session',
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.GamePlaySession,
    conditions: { householdId: '{{ householdId }}' },
    slug: 'delete:game_play_session:household',
    riskLevel: RiskLevel.Medium,
    reason: "Delete your household's game sessions",
  }),
  permission({
    action: Action.create,
    subject: ResourceType.SessionPlayer,
    slug: 'create:session_player:join',
    riskLevel: RiskLevel.Low,
    reason: 'Join a game session',
  }),
  permission({
    action: Action.create,
    subject: ResourceType.SessionPlayer,
    conditions: { gamePlaySession: { is: { occurrence: { is: { eventId: '{{ eventId }}' } } } } },
    slug: 'create:session_player:observer:join',
    riskLevel: RiskLevel.Low,
    reason: 'Join a game session as observer',
  }),

  // --- Rule Variants ---
  // TODO: own rules vs admin/moderator
  permission({
    action: Action.create,
    subject: ResourceType.RuleVariant,
    slug: 'create:rule_variant',
    riskLevel: RiskLevel.Low,
    reason: 'Create rule variant',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.RuleVariant,
    conditions: {
      createdById: '{{ user.id }}',
    },
    slug: 'update:rule_variant',
    riskLevel: RiskLevel.Low,
    reason: 'Update rule variant',
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.RuleVariant,
    conditions: {
      createdById: '{{ user.id }}',
    },
    slug: 'delete:rule_variant',
    riskLevel: RiskLevel.Low,
    reason: 'Delete rule variant',
  }),

  // --- Media ---
  // Media reaches an event only through its typed join rows, so the
  // participant's upload grant names all three.
  permission({
    action: Action.create,
    subject: ResourceType.Media,
    conditions: {
      OR: [
        { eventImages: { some: { eventId: '{{ eventId }}' } } },
        { eventVideos: { some: { eventId: '{{ eventId }}' } } },
        { eventDocuments: { some: { eventId: '{{ eventId }}' } } },
      ],
    },
    slug: 'create:media:upload',
    riskLevel: RiskLevel.Low,
    reason: 'Upload media',
  }),

  // ─── MediaObject ────────────────────────────────────────
  permission({
    action: Action.create,
    subject: ResourceType.MediaObject,
    slug: 'create:media_object',
    riskLevel: RiskLevel.Low,
    reason: 'Upload a media object',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.MediaObject,
    conditions: { ownerId: '{{ user.id }}' },
    slug: 'read:media_object:own',
    riskLevel: RiskLevel.Low,
    reason: 'View own media objects',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.MediaObject,
    conditions: { visibility: 'Public' },
    slug: 'read:media_object:public',
    riskLevel: RiskLevel.Low,
    reason: 'View public media objects',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.MediaObject,
    conditions: { ownerId: '{{ user.id }}' },
    slug: 'update:media_object:own',
    riskLevel: RiskLevel.Low,
    reason: 'Update own media objects (publish/unpublish, attach/detach)',
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.MediaObject,
    conditions: { ownerId: '{{ user.id }}' },
    slug: 'delete:media_object:own',
    riskLevel: RiskLevel.Low,
    reason: 'Delete own media objects',
  }),

  // ─── MediaContribution ──────────────────────────────────
  permission({
    action: Action.create,
    subject: ResourceType.MediaContribution,
    conditions: { contributedById: '{{ user.id }}' },
    slug: 'create:media_contribution',
    riskLevel: RiskLevel.Low,
    reason: 'Contribute own media to a game or event',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.MediaContribution,
    conditions: { contributedById: '{{ user.id }}' },
    slug: 'update:media_contribution:reclaim',
    riskLevel: RiskLevel.Low,
    reason: 'Reclaim own contribution before its deadline',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.MediaContribution,
    slug: 'read:media_contribution',
    riskLevel: RiskLevel.Medium,
    reason: 'View contributions for moderation',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.MediaContribution,
    slug: 'update:media_contribution:moderate',
    riskLevel: RiskLevel.Medium,
    reason: 'Approve or reject media contributions',
  }),

  // --- Customization ---
  permission({
    action: Action.create,
    subject: ResourceType.UserGameCustomization,
    slug: 'create:user_game_customization',
    riskLevel: RiskLevel.Low,
    reason: 'Create customization',
  }),
  permission({
    action: Action.update,
    subject: ResourceType.UserGameCustomization,
    conditions: {
      userId: '{{ user.id }}',
    },
    slug: 'update:user_game_customization',
    riskLevel: RiskLevel.Low,
    reason: 'Update customization',
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.UserGameCustomization,
    conditions: {
      userId: '{{ user.id }}',
    },
    slug: 'delete:user_game_customization',
    riskLevel: RiskLevel.Low,
    reason: 'Delete customization',
  }),

  // ─── Feedback ───────────────────────────────────────────
  permission({
    action: Action.create,
    subject: ResourceType.FeedbackReport,
    slug: 'create:feedback_report',
    riskLevel: RiskLevel.Low,
    reason: 'Submit a feedback report',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.FeedbackReport,
    conditions: { userId: '{{ user.id }}' },
    slug: 'read:feedback_report:own',
    riskLevel: RiskLevel.Low,
    reason: 'Read own feedback reports',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.FeedbackReport,
    slug: 'read:feedback_report',
    riskLevel: RiskLevel.High,
    reason: 'Read any feedback report',
  }),
  permission({
    action: Action.delete,
    subject: ResourceType.FeedbackReport,
    slug: 'delete:feedback_report',
    riskLevel: RiskLevel.High,
    reason: 'Hard-delete a feedback report (separate from retention sweep)',
  }),
  permission({
    action: Action.manage,
    subject: ResourceType.FeedbackReport,
    slug: 'manage:feedback_report',
    riskLevel: RiskLevel.High,
    reason: 'Full administrative control over feedback reports',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.FeedbackSinkDispatch,
    slug: 'read:feedback_sink_dispatch',
    riskLevel: RiskLevel.Medium,
    reason: 'Read sink-dispatch audit trail',
  }),

  // ─── SafeHttpPolicy ─────────────────────────────────────
  permission({
    action: Action.read,
    subject: ResourceType.SafeHttpPolicy,
    slug: 'read:safe_http_policy',
    riskLevel: RiskLevel.Medium,
    reason: 'View the outbound HTTP SSRF policy',
  }),
  permission({
    action: Action.manage,
    subject: ResourceType.SafeHttpPolicy,
    slug: 'manage:safe_http_policy',
    riskLevel: RiskLevel.Critical,
    reason:
      'Manage the outbound HTTP SSRF policy — timeouts, redirect limits, strict mode, and host/CIDR allow/block lists',
  }),

  // ─── Plugin administration (#59 Phase C4) ───────────────────────────────
  // Server-scope pair: no explicit role assignment in ROLE_PERMISSION_CATALOG
  // — Owner holds it via `manage:all`, Admin via that catalog's derived
  // every-slug-except-`manage:all` list — Owner/Admin only,
  // per the locked role assignment on #59. Plugin principals can NEVER hold the `manage:` pair regardless of
  // rows: the runtime's hard exclusion matches `manage:plugin*` by pattern
  // on purpose (both slugs are pinned against it by the runtime's
  // consent-gate specs), so these seeds change what admins may do, not what
  // the gate refuses. The `read:` pair is deliberately OUTSIDE that
  // exclusion (decision recorded on #59, 2026-08-15): consent decides it,
  // not a categorical gate. In practice that means `read:plugin` — it is
  // condition-free, so a manifest may request it as an ordinary
  // admin-consentable check under unit-bounded conferral; it reveals
  // plugin/consent topology, which is why it is Medium rather than Low.
  // `read:plugin:household` is nominally consentable too, but its CLS
  // `{{ householdId }}` template below renders only for USER abilities
  // (the unit-coordinate variants are #315's work — this row cannot carry
  // both forms). A plugin granted it does not lose just that grant: the
  // render rejection fails the plugin's ENTIRE ability for the unit
  // (deny-all, logged loud) until the grant is revoked — do not grant it
  // to plugins as seeded.
  permission({
    action: Action.manage,
    subject: ResourceType.Plugin,
    slug: 'manage:plugin',
    riskLevel: RiskLevel.Critical,
    reason:
      'Install, update, and uninstall server plugins and approve their permission grants — permission mutation by proxy',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.Plugin,
    slug: 'read:plugin',
    riskLevel: RiskLevel.Medium,
    reason: 'View installed plugins, their manifests, pending updates, and server consent state',
  }),
  // Household-scope pair: conditioned on the CLS household like the other
  // household permissions (`read:household`) — HouseholdPlugin carries the
  // scalar `householdId`, so instance checks stay bounded to the household
  // the request is operating in.
  permission({
    action: Action.manage,
    subject: ResourceType.HouseholdPlugin,
    conditions: { householdId: '{{ householdId }}' },
    slug: 'manage:plugin:household',
    riskLevel: RiskLevel.Medium,
    reason:
      'Enable, disable, configure, and consent to plugins for a household — enabling third-party code outranks ordinary household-scoped writes',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.HouseholdPlugin,
    conditions: { householdId: '{{ householdId }}' },
    slug: 'read:plugin:household',
    riskLevel: RiskLevel.Low,
    reason: "View a household's enabled plugins, their feature state, and consent status",
  }),

  // --- Webhook Subscriptions ─────────────────────────────────────
  permission({
    action: Action.manage,
    subject: ResourceType.WebhookSubscription,
    conditions: { createdById: '{{ user.id }}' },
    slug: 'manage:webhook_subscription:own',
    riskLevel: RiskLevel.Medium,
    reason: 'Manage own webhook subscriptions',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.WebhookSubscription,
    conditions: { createdById: '{{ user.id }}' },
    slug: 'read:webhook_subscription:own',
    riskLevel: RiskLevel.Low,
    reason: 'View own webhook subscriptions',
  }),

  // --- Audit Log ──────────────────────────────────────────
  // Read-only by design — there is no mutation API for audit rows.
  permission({
    action: Action.read,
    subject: ResourceType.AuditLog,
    slug: 'read:audit_log',
    riskLevel: RiskLevel.High,
    reason: 'View the persisted audit trail',
  }),

  // --- Quotas ─────────────────────────────────────────────
  permission({
    action: Action.manage,
    subject: ResourceType.Quota,
    slug: 'manage:quota',
    riskLevel: RiskLevel.High,
    reason: 'Manage operational quotas',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.Quota,
    slug: 'read:quota',
    riskLevel: RiskLevel.Medium,
    reason: 'View operational quotas',
  }),
  permission({
    action: Action.read,
    subject: ResourceType.Quota,
    conditions: { householdId: '{{ householdId }}' },
    slug: 'read:quota:household',
    riskLevel: RiskLevel.Low,
    reason: "View this household's own and per-member quota caps",
  }),
  permission({
    action: Action.manage,
    subject: ResourceType.Quota,
    conditions: { scope: 'HouseholdMember', householdId: '{{ householdId }}' },
    slug: 'manage:quota:household_member',
    riskLevel: RiskLevel.Low,
    reason: 'Sub-allocate member quotas within own household',
  }),
] as const satisfies readonly DefinedPermission<CatalogSubject, string>[];

/** Literal union of every seeded permission slug. */
export type PermissionSlug = (typeof PERMISSION_CATALOG)[number]['slug'];

assertUniqueSlugs(PERMISSION_CATALOG);
assertValidSubjects(PERMISSION_CATALOG);
assertJsonConditions(PERMISSION_CATALOG);
