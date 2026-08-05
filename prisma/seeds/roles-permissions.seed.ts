import type { Permission, Prisma, Role } from '@bge/database';
import { Action, PrismaClient, ResourceType, RiskLevel, SystemRole } from '@bge/database';
import type { Logger } from '@nestjs/common';

/**
 * One entry in the seeded permission catalog.
 *
 * `riskLevel` is REQUIRED at the type level: the compiler — not a runtime
 * check — guarantees that no seeded permission relies on the schema default
 * (#60). Omitting a classification on a new entry fails the build. The
 * `@default(Low)` on the Prisma column exists only for rows created outside
 * this seed (plugin-declared permissions; their classification is decided in
 * #59 Phase C).
 */
interface PermissionSeedDefinition {
  action: Action;

  /**
   * ResourceType for domain permissions; literal 'all' for the global wildcards.
   */
  subject: ResourceType | 'all';

  /**
   * Stable code-side identifier, e.g. 'read:game'.
   */
  slug: string;

  /**
   * Consent-surface risk classification (#60 canonical rubric).
   */
  riskLevel: RiskLevel;

  reason: string;

  /**
   * Mustache-templated ABAC conditions, rendered by the ability factory.
   */
  conditions?: Prisma.InputJsonObject;

  fields?: string[];
}

/**
 * Initialize default roles and permissions
 *
 * @todo refinements - these need work
 */
export async function rolesAndPermissionsSeed(prisma: PrismaClient, logger: Logger) {
  // ============================================
  // PERMISSIONS
  // ============================================
  logger.log('📋 Creating permissions...');

  // Relational clause meaning "this User node is an accepted friend of the
  // acting user". A friendship is a single directional row, so both directions
  // must be checked. Rendered by the ability factory against `{{ user.id }}`
  // and evaluated live against the friendship table at query time.
  const acceptedFriendOfActingUser = {
    OR: [
      { friendshipsRequested: { some: { addresseeId: '{{ user.id }}', status: 'Accepted' } } },
      { friendshipsReceived: { some: { requesterId: '{{ user.id }}', status: 'Accepted' } } },
    ],
  };

  const permissionsToCreate: PermissionSeedDefinition[] = [
    // --- Global Admin/Owner ---
    {
      action: Action.manage,
      subject: 'all',
      slug: 'manage:all',
      riskLevel: RiskLevel.Critical,
      reason: 'Unrestricted access for Owner',
    },
    {
      action: Action.manage,
      subject: 'all',
      slug: 'manage:content:moderate',
      riskLevel: RiskLevel.Critical,
      reason: 'Moderate app content',
    },
    {
      action: Action.read,
      subject: 'all',
      slug: 'read:public_content',
      riskLevel: RiskLevel.Low,
      reason: 'View public content',
    },

    // --- App Level / User ---
    // TODO: consider the ability to block other users from viewing your profile, etc.
    {
      action: Action.read,
      subject: ResourceType.UserProfile,
      slug: 'read:user:profile',
      riskLevel: RiskLevel.High,
      reason: 'View user profiles',
    },
    {
      action: Action.update,
      subject: ResourceType.UserProfile,
      conditions: { userId: '{{ user.id }}' },
      slug: 'update:user:profile:own',
      riskLevel: RiskLevel.Low,
      reason: 'Update own profile',
    },

    // --- Friendships ---
    // Self-management: the acting user is a participant (requester or addressee).
    {
      action: Action.create,
      subject: ResourceType.Friendship,
      conditions: { requesterId: '{{ user.id }}' },
      slug: 'create:friendship',
      riskLevel: RiskLevel.Low,
      reason: 'Send a friend request',
    },
    {
      action: Action.read,
      subject: ResourceType.Friendship,
      conditions: { OR: [{ requesterId: '{{ user.id }}' }, { addresseeId: '{{ user.id }}' }] },
      slug: 'read:friendships:own',
      riskLevel: RiskLevel.Low,
      reason: 'View your own friendships and requests',
    },
    {
      action: Action.update,
      subject: ResourceType.Friendship,
      conditions: { OR: [{ requesterId: '{{ user.id }}' }, { addresseeId: '{{ user.id }}' }] },
      slug: 'update:friendship:own',
      riskLevel: RiskLevel.Low,
      reason: 'Respond to, withdraw, or block a friendship you are part of',
    },
    {
      action: Action.delete,
      subject: ResourceType.Friendship,
      conditions: { OR: [{ requesterId: '{{ user.id }}' }, { addresseeId: '{{ user.id }}' }] },
      slug: 'delete:friendship:own',
      riskLevel: RiskLevel.Low,
      reason: 'Remove a friendship you are part of',
    },
    // Friend visibility: read resources exposed to friends by their owner.
    {
      action: Action.read,
      subject: ResourceType.Event,
      conditions: { visibility: 'Friends', createdBy: acceptedFriendOfActingUser },
      slug: 'read:event:friends',
      riskLevel: RiskLevel.Medium,
      reason: "View a friend's friends-visible events",
    },
    {
      action: Action.read,
      subject: ResourceType.Household,
      conditions: { visibility: 'Friends', members: { some: { user: acceptedFriendOfActingUser } } },
      slug: 'read:households:friends',
      riskLevel: RiskLevel.Medium,
      reason: "View a friend's friends-visible households",
    },

    // --- Games ---
    {
      action: Action.read,
      subject: ResourceType.Game,
      slug: 'read:game',
      riskLevel: RiskLevel.Low,
      reason: 'View games',
    },
    {
      action: Action.read,
      subject: ResourceType.Job,
      slug: 'read:job',
      riskLevel: RiskLevel.Medium,
      reason: 'View import/system job status',
    },
    {
      action: Action.create,
      subject: ResourceType.Game,
      slug: 'create:game',
      riskLevel: RiskLevel.Low,
      reason: 'Create games',
    },
    {
      action: Action.update,
      subject: ResourceType.Game,
      slug: 'update:game',
      riskLevel: RiskLevel.High,
      reason: 'Update games',
    },
    {
      action: Action.delete,
      subject: ResourceType.Game,
      slug: 'delete:game',
      riskLevel: RiskLevel.High,
      reason: 'Delete games',
    },

    {
      action: Action.update,
      subject: ResourceType.Game,
      slug: 'update:game:own',
      riskLevel: RiskLevel.Low,
      reason: 'Update own games',
      conditions: { createdById: '{{ user.id }}' },
    },
    {
      action: Action.delete,
      subject: ResourceType.Game,
      slug: 'delete:game:own',
      riskLevel: RiskLevel.Low,
      reason: 'Delete own games',
      conditions: { createdById: '{{ user.id }}' },
    },

    // --- PlatformGame ---
    {
      action: Action.read,
      subject: ResourceType.PlatformGame,
      slug: 'read:platform_game',
      riskLevel: RiskLevel.Low,
      reason: 'View platform-specific game entries',
    },
    {
      action: Action.create,
      subject: ResourceType.PlatformGame,
      slug: 'create:platform_game',
      riskLevel: RiskLevel.Medium,
      reason: 'Create a platform-specific game entry (import pipelines)',
    },
    {
      action: Action.update,
      subject: ResourceType.PlatformGame,
      slug: 'update:platform_game',
      riskLevel: RiskLevel.Medium,
      reason: 'Update platform-specific game capabilities or overrides',
    },
    {
      action: Action.delete,
      subject: ResourceType.PlatformGame,
      slug: 'delete:platform_game',
      riskLevel: RiskLevel.Medium,
      reason: 'Remove a platform-specific game entry',
    },

    // --- Platform ---
    {
      action: Action.read,
      subject: ResourceType.Platform,
      slug: 'read:platform',
      riskLevel: RiskLevel.Low,
      reason: 'View platforms',
    },
    {
      action: Action.create,
      subject: ResourceType.Platform,
      slug: 'create:platform',
      riskLevel: RiskLevel.Medium,
      reason: 'Create platforms',
    },
    {
      action: Action.update,
      subject: ResourceType.Platform,
      slug: 'update:platform',
      riskLevel: RiskLevel.Medium,
      reason: 'Update platforms',
    },
    {
      action: Action.delete,
      subject: ResourceType.Platform,
      slug: 'delete:platform',
      riskLevel: RiskLevel.Medium,
      reason: 'Delete platforms',
    },

    // ─── EventOccurrence ────────────────────────────────
    {
      action: Action.read,
      subject: ResourceType.EventOccurrence,
      slug: 'read:event_occurrence',
      riskLevel: RiskLevel.Medium,
      reason: 'View event occurrences',
    },
    {
      action: Action.create,
      subject: ResourceType.EventOccurrence,
      slug: 'create:event_occurrence',
      riskLevel: RiskLevel.Medium,
      reason: 'Add occurrences to an event',
    },
    {
      action: Action.update,
      subject: ResourceType.EventOccurrence,
      slug: 'update:event_occurrence',
      riskLevel: RiskLevel.Medium,
      reason: 'Update occurrence details (label, date, location)',
    },
    {
      action: Action.delete,
      subject: ResourceType.EventOccurrence,
      slug: 'delete:event_occurrence',
      riskLevel: RiskLevel.Medium,
      reason: 'Remove an occurrence from an event',
    },
    {
      action: Action.update,
      subject: ResourceType.EventOccurrence,
      slug: 'update:event_occurrence:confirm',
      riskLevel: RiskLevel.Medium,
      reason: 'Confirm a proposed occurrence (Proposed → Confirmed)',
    },
    {
      action: Action.update,
      subject: ResourceType.EventOccurrence,
      slug: 'update:event_occurrence:decline',
      riskLevel: RiskLevel.Medium,
      reason: 'Decline a proposed occurrence (Proposed → Declined)',
    },
    {
      action: Action.update,
      subject: ResourceType.EventOccurrence,
      slug: 'update:event_occurrence:cancel',
      riskLevel: RiskLevel.Medium,
      reason: 'Cancel a confirmed occurrence (Confirmed → Cancelled)',
    },

    // ─── EventAvailabilityVote ──────────────────────────
    {
      action: Action.read,
      subject: ResourceType.EventAvailabilityVote,
      slug: 'read:event_availability_vote',
      riskLevel: RiskLevel.Medium,
      reason: 'View availability votes and summary',
    },
    {
      action: Action.create,
      subject: ResourceType.EventAvailabilityVote,
      conditions: { attendee: { userId: '{{ user.id }}' } },
      slug: 'create:event_availability_vote',
      riskLevel: RiskLevel.Low,
      reason: 'Submit or update your availability vote on a proposed occurrence',
    },

    // ─── EventAttendee ──────────────────────────────────
    {
      action: Action.read,
      subject: ResourceType.EventAttendee,
      conditions: { event: { id: '{{ eventId }}' } },
      slug: 'read:event_attendee',
      riskLevel: RiskLevel.Medium,
      reason: 'View event attendees',
    },
    {
      action: Action.update,
      subject: ResourceType.EventAttendee,
      fields: ['status', 'notes'],
      conditions: { userId: '{{ user.id }}' },
      slug: 'update:event_attendee:status:self',
      riskLevel: RiskLevel.Low,
      reason: 'Update own RSVP status',
    },
    {
      action: Action.update,
      subject: ResourceType.EventAttendee,
      fields: ['status', 'notes'],
      conditions: { event: { id: '{{ eventId }}' } },
      slug: 'update:event_attendee:status',
      riskLevel: RiskLevel.Medium,
      reason: 'Update any attendee status within an event (host-managed)',
    },

    // ─── EventGameNomination ────────────────────────────
    {
      action: Action.read,
      subject: ResourceType.EventGameNomination,
      slug: 'read:event_game_nomination',
      riskLevel: RiskLevel.Medium,
      reason: 'View game nominations',
    },
    {
      action: Action.create,
      subject: ResourceType.EventGameNomination,
      slug: 'create:event_game_nomination',
      riskLevel: RiskLevel.Low,
      reason: 'Nominate a game for the event',
    },
    {
      action: Action.update,
      subject: ResourceType.EventGameNomination,
      conditions: { nominatedBy: { userId: '{{ user.id }}' } },
      slug: 'update:event_game_nomination:withdraw',
      riskLevel: RiskLevel.Low,
      reason: 'Withdraw your own nomination',
    },
    {
      action: Action.update,
      subject: ResourceType.EventGameNomination,
      slug: 'update:event_game_nomination:resolve',
      riskLevel: RiskLevel.Medium,
      reason: 'Resolve a nomination (tally votes)',
    },
    {
      action: Action.update,
      subject: ResourceType.EventGameNomination,
      slug: 'update:event_game_nomination:approve',
      riskLevel: RiskLevel.Medium,
      reason: 'Approve a nomination (HostApproval mode)',
    },
    {
      action: Action.update,
      subject: ResourceType.EventGameNomination,
      slug: 'update:event_game_nomination:reject',
      riskLevel: RiskLevel.Medium,
      reason: 'Reject a nomination (HostApproval mode)',
    },

    // ─── EventGameVote ──────────────────────────────────
    {
      action: Action.read,
      subject: ResourceType.EventGameVote,
      slug: 'read:event_game_vote',
      riskLevel: RiskLevel.Medium,
      reason: 'View game nomination votes',
    },
    {
      action: Action.create,
      subject: ResourceType.EventGameVote,
      conditions: { attendee: { userId: '{{ user.id }}' } },
      slug: 'create:event_game_vote',
      riskLevel: RiskLevel.Low,
      reason: 'Cast or update your vote on a nomination',
    },

    // ─── EventGame ──────────────────────────────────────
    {
      action: Action.read,
      subject: ResourceType.EventGame,
      slug: 'read:event_game',
      riskLevel: RiskLevel.Low,
      reason: 'View the event game lineup',
    },
    {
      action: Action.create,
      subject: ResourceType.EventGame,
      slug: 'create:event_game',
      riskLevel: RiskLevel.Medium,
      reason: 'Directly add a game to the event lineup',
    },
    {
      action: Action.delete,
      subject: ResourceType.EventGame,
      slug: 'delete:event_game',
      riskLevel: RiskLevel.Medium,
      reason: 'Remove a game from the event lineup',
    },

    // ─── EventAttendeeGameList ──────────────────────────
    {
      action: Action.read,
      subject: ResourceType.EventAttendeeGameList,
      slug: 'read:attendee_game_list',
      riskLevel: RiskLevel.Medium,
      reason: "View an attendee's available game list",
    },
    {
      action: Action.create,
      subject: ResourceType.EventAttendeeGameList,
      conditions: { attendee: { userId: '{{ user.id }}' } },
      slug: 'create:attendee_game_list',
      riskLevel: RiskLevel.Low,
      reason: 'Add a game to your own available game list',
    },
    {
      action: Action.delete,
      subject: ResourceType.EventAttendeeGameList,
      conditions: { attendee: { userId: '{{ user.id }}' } },
      slug: 'delete:attendee_game_list',
      riskLevel: RiskLevel.Low,
      reason: 'Remove a game from your own available game list',
    },
    {
      action: Action.manage,
      subject: ResourceType.EventAttendeeGameList,
      slug: 'manage:attendee_game_list',
      riskLevel: RiskLevel.Medium,
      reason: "Manage any attendee's available game list",
    },

    // ─── EventPolicy ────────────────────────────────────
    {
      action: Action.read,
      subject: ResourceType.EventPolicy,
      slug: 'read:event_policy',
      riskLevel: RiskLevel.Low,
      reason: 'View event policy configuration',
    },
    {
      action: Action.update,
      subject: ResourceType.EventPolicy,
      slug: 'update:event_policy',
      riskLevel: RiskLevel.Medium,
      reason: 'Update event policy configuration',
    },

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
    {
      action: Action.read,
      subject: ResourceType.GameCollection,
      conditions: { userId: '{{ user.id }}' },
      slug: 'read:game_collection',
      riskLevel: RiskLevel.Low,
      reason: 'View your own game collection',
    },
    // Row visible when the owner shares a household with the acting user, the
    // owner's membership in that household has `showAllGames`, the row is not
    // excluded from a household the acting user belongs to, and the row's
    // visibility admits household viewers.
    //
    // Known approximation: `showAllGames` and the ExcludedGame check cannot be
    // correlated to the *same* shared household from inside this flat Prisma
    // clause — when owner and viewer share 2+ households with differing
    // exclusions/flags, an exclusion in any shared household hides the row.
    {
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
    },
    // Row visible to accepted friends of the owner when the owner's
    // preferences allow it (absent preferences row → schema default `true`,
    // mirroring FriendshipService). FriendsOfFriends currently grants to
    // direct friends only — 2-hop traversal is deferred.
    {
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
    },
    {
      action: Action.read,
      subject: ResourceType.GameCollection,
      conditions: { deletedAt: null, visibility: 'Public' },
      slug: 'read:game_collection:public',
      riskLevel: RiskLevel.Low,
      reason: 'View public collections',
    },
    {
      action: Action.create,
      subject: ResourceType.GameCollection,
      conditions: { userId: '{{ user.id }}' },
      slug: 'create:game_collection',
      riskLevel: RiskLevel.Low,
      reason: 'Add game to collection',
    },
    {
      action: Action.update,
      subject: ResourceType.GameCollection,
      conditions: { userId: '{{ user.id }}' },
      slug: 'update:game_collection',
      riskLevel: RiskLevel.Low,
      reason: 'Update game in collection',
    },
    {
      action: Action.delete,
      subject: ResourceType.GameCollection,
      conditions: { userId: '{{ user.id }}' },
      slug: 'delete:game_collection',
      riskLevel: RiskLevel.Low,
      reason: 'Remove game from collection',
    },

    // --- Game Gateway ---
    {
      action: Action.read,
      subject: ResourceType.GameGateway,
      slug: 'read:game_gateway',
      riskLevel: RiskLevel.High,
      reason: 'View game gateway connections',
    },
    {
      action: Action.create,
      subject: ResourceType.GameGateway,
      slug: 'create:game_gateway',
      riskLevel: RiskLevel.High,
      reason: 'Create game gateway connections',
    },
    {
      action: Action.update,
      subject: ResourceType.GameGateway,
      slug: 'update:game_gateway',
      riskLevel: RiskLevel.High,
      reason: 'Update game gateway connections',
    },
    {
      action: Action.delete,
      subject: ResourceType.GameGateway,
      slug: 'delete:game_gateway',
      riskLevel: RiskLevel.High,
      reason: 'Delete game gateway connections',
    },

    // --- Households ---
    {
      action: Action.create,
      subject: ResourceType.Household,
      slug: 'create:household',
      riskLevel: RiskLevel.Low,
      reason: 'Create a household',
    },
    {
      action: Action.read,
      subject: ResourceType.Household,
      conditions: {
        members: { some: { userId: '{{ user.id }}' } },
      },
      slug: 'read:households',
      riskLevel: RiskLevel.Low,
      reason: 'View households',
    },
    {
      action: Action.read,
      subject: ResourceType.Household,
      conditions: {
        id: '{{ householdId }}',
      },
      slug: 'read:household',
      riskLevel: RiskLevel.Low,
      reason: 'View household details',
    },

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
    {
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
    },
    {
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
    },
    {
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
    },
    {
      action: Action.read,
      subject: ResourceType.HouseholdMember,
      conditions: { householdId: '{{ householdId }}' },
      slug: 'read:household_member',
      riskLevel: RiskLevel.Low,
      reason: 'View the member roster of a household you belong to',
    },
    // Roster readability follows household readability: a friend can already
    // read the full member list through getHouseholdById's embed under
    // read:households:friends, so the sub-resource grants the same visibility.
    {
      action: Action.read,
      subject: ResourceType.HouseholdMember,
      conditions: {
        household: { visibility: 'Friends', members: { some: { user: acceptedFriendOfActingUser } } },
      },
      slug: 'read:household_member:friends',
      riskLevel: RiskLevel.Medium,
      reason: "View the member roster of a friend's friends-visible household",
    },
    // Self-scoped by conditions: the `userId` pin means every household role
    // can hold this grant without conferring removal power over anyone else.
    // The service additionally pins `userId` in its `where` because CASL
    // `manage` implies `delete` — an Owner/Admin's delete conditions cover the
    // whole roster, and "leave" must mean the acting user's own row.
    {
      action: Action.delete,
      subject: ResourceType.HouseholdMember,
      conditions: {
        userId: '{{ user.id }}',
        householdId: '{{ householdId }}',
      },
      slug: 'delete:household_member:leave',
      riskLevel: RiskLevel.Low,
      reason: 'Leave a household you belong to',
    },
    {
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
    },
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
    // HouseholdAdmin — see `disallowedHouseholdAdminPermissions` below. #234's
    // walker is where this becomes machine-checked.
    {
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
    },

    // TODO: maybe defer to a household policy?
    {
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
    },

    // TODO: this is likely too simplistic
    {
      action: Action.create,
      subject: ResourceType.HouseholdMember,
      conditions: {
        householdId: '{{ householdId }}',
      },
      slug: 'create:household_member:join',
      riskLevel: RiskLevel.Medium,
      reason: 'Join household',
    },

    // --- Events ---
    {
      action: Action.create,
      subject: ResourceType.Event,
      slug: 'create:event',
      riskLevel: RiskLevel.Low,
      reason: 'Create an event',
    },

    // TODO household specific event permissions? i.e read:household_event etc
    {
      action: Action.read,
      subject: ResourceType.Event,
      slug: 'read:event',
      riskLevel: RiskLevel.High,
      reason: 'View any event (moderation/admin)',
    },
    {
      action: Action.read,
      subject: ResourceType.Event,
      conditions: {
        id: '{{ eventId }}',
        attendees: { some: { userId: '{{ user.id }}' } },
      },
      slug: 'read:event:participant',
      riskLevel: RiskLevel.Low,
      reason: 'View an event you attend',
    },
    {
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
    },
    {
      action: Action.delete,
      subject: ResourceType.Event,
      conditions: { createdById: '{{ user.id }}' },
      slug: 'delete:event',
      riskLevel: RiskLevel.Low,
      reason: 'Delete an event as creator',
    },

    // TODO: this needs conditions to validate moderator role and scope
    {
      action: Action.delete,
      subject: ResourceType.Event,
      slug: 'delete:event:moderate',
      riskLevel: RiskLevel.High,
      reason: 'Delete any event as moderator',
    },

    // TODO: this doesn't actually ensure the event is being cancelled...
    {
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
    },

    // An event can be archived if it is cancelled and the user is the host
    {
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
    },
    {
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
    },
    {
      action: Action.manage,
      subject: ResourceType.EventAttendee,
      conditions: { eventId: '{{ eventId }}' },
      slug: 'manage:event_attendee',
      riskLevel: RiskLevel.Medium,
      reason: 'Manage event participants',
    },

    // --- Game Sessions ---
    {
      action: Action.create,
      subject: ResourceType.GamePlayResult,
      slug: 'create:play_record',
      riskLevel: RiskLevel.Low,
      reason: 'Create a play record',
    },
    {
      action: Action.read,
      subject: ResourceType.GamePlaySession,
      slug: 'read:game_play_session',
      riskLevel: RiskLevel.Medium,
      reason: 'View a game session',
    },
    {
      action: Action.create,
      subject: ResourceType.GamePlaySession,
      slug: 'create:game_play_session',
      riskLevel: RiskLevel.Low,
      reason: 'Create a game session',
    },
    {
      action: Action.update,
      subject: ResourceType.GamePlaySession,
      slug: 'update:game_play_session',
      riskLevel: RiskLevel.Medium,
      reason: 'Update a game session',
    },
    {
      action: Action.delete,
      subject: ResourceType.GamePlaySession,
      slug: 'delete:game_play_session',
      riskLevel: RiskLevel.Medium,
      reason: 'Delete a game session',
    },
    {
      action: Action.create,
      subject: ResourceType.SessionPlayer,
      slug: 'create:session_player:join',
      riskLevel: RiskLevel.Low,
      reason: 'Join a game session',
    },
    {
      action: Action.create,
      subject: ResourceType.SessionPlayer,
      slug: 'create:session_player:observer:join',
      riskLevel: RiskLevel.Low,
      reason: 'Join a game session as observer',
    },

    // --- Rule Variants ---
    // TODO: own rules vs admin/moderator
    {
      action: Action.create,
      subject: ResourceType.RuleVariant,
      slug: 'create:rule_variant',
      riskLevel: RiskLevel.Low,
      reason: 'Create rule variant',
    },
    {
      action: Action.update,
      subject: ResourceType.RuleVariant,
      conditions: {
        createdById: '{{ user.id }}',
      },
      slug: 'update:rule_variant',
      riskLevel: RiskLevel.Low,
      reason: 'Update rule variant',
    },
    {
      action: Action.delete,
      subject: ResourceType.RuleVariant,
      conditions: {
        createdById: '{{ user.id }}',
      },
      slug: 'delete:rule_variant',
      riskLevel: RiskLevel.Low,
      reason: 'Delete rule variant',
    },

    // --- Media ---
    {
      action: Action.create,
      subject: ResourceType.Media,
      slug: 'create:media:upload',
      riskLevel: RiskLevel.Low,
      reason: 'Upload media',
    },

    // ─── MediaObject ────────────────────────────────────────
    {
      action: Action.create,
      subject: ResourceType.MediaObject,
      slug: 'create:media_object',
      riskLevel: RiskLevel.Low,
      reason: 'Upload a media object',
    },
    {
      action: Action.read,
      subject: ResourceType.MediaObject,
      conditions: { ownerId: '{{ user.id }}' },
      slug: 'read:media_object:own',
      riskLevel: RiskLevel.Low,
      reason: 'View own media objects',
    },
    {
      action: Action.read,
      subject: ResourceType.MediaObject,
      conditions: { visibility: 'Public' },
      slug: 'read:media_object:public',
      riskLevel: RiskLevel.Low,
      reason: 'View public media objects',
    },
    {
      action: Action.update,
      subject: ResourceType.MediaObject,
      conditions: { ownerId: '{{ user.id }}' },
      slug: 'update:media_object:own',
      riskLevel: RiskLevel.Low,
      reason: 'Update own media objects (publish/unpublish, attach/detach)',
    },
    {
      action: Action.delete,
      subject: ResourceType.MediaObject,
      conditions: { ownerId: '{{ user.id }}' },
      slug: 'delete:media_object:own',
      riskLevel: RiskLevel.Low,
      reason: 'Delete own media objects',
    },

    // ─── MediaContribution ──────────────────────────────────
    {
      action: Action.create,
      subject: ResourceType.MediaContribution,
      conditions: { contributedById: '{{ user.id }}' },
      slug: 'create:media_contribution',
      riskLevel: RiskLevel.Low,
      reason: 'Contribute own media to a game or event',
    },
    {
      action: Action.update,
      subject: ResourceType.MediaContribution,
      conditions: { contributedById: '{{ user.id }}' },
      slug: 'update:media_contribution:reclaim',
      riskLevel: RiskLevel.Low,
      reason: 'Reclaim own contribution before its deadline',
    },
    {
      action: Action.read,
      subject: ResourceType.MediaContribution,
      slug: 'read:media_contribution',
      riskLevel: RiskLevel.Medium,
      reason: 'View contributions for moderation',
    },
    {
      action: Action.update,
      subject: ResourceType.MediaContribution,
      slug: 'update:media_contribution:moderate',
      riskLevel: RiskLevel.Medium,
      reason: 'Approve or reject media contributions',
    },

    // --- Customization ---
    {
      action: Action.create,
      subject: ResourceType.UserGameCustomization,
      slug: 'create:user_game_customization',
      riskLevel: RiskLevel.Low,
      reason: 'Create customization',
    },
    {
      action: Action.update,
      subject: ResourceType.UserGameCustomization,
      conditions: {
        userId: '{{ user.id }}',
      },
      slug: 'update:user_game_customization',
      riskLevel: RiskLevel.Low,
      reason: 'Update customization',
    },
    {
      action: Action.delete,
      subject: ResourceType.UserGameCustomization,
      conditions: {
        userId: '{{ user.id }}',
      },
      slug: 'delete:user_game_customization',
      riskLevel: RiskLevel.Low,
      reason: 'Delete customization',
    },

    // ─── Feedback ───────────────────────────────────────────
    {
      action: Action.create,
      subject: ResourceType.FeedbackReport,
      slug: 'create:feedback_report',
      riskLevel: RiskLevel.Low,
      reason: 'Submit a feedback report',
    },
    {
      action: Action.read,
      subject: ResourceType.FeedbackReport,
      conditions: { userId: '{{ user.id }}' },
      slug: 'read:feedback_report:own',
      riskLevel: RiskLevel.Low,
      reason: 'Read own feedback reports',
    },
    {
      action: Action.read,
      subject: ResourceType.FeedbackReport,
      slug: 'read:feedback_report',
      riskLevel: RiskLevel.High,
      reason: 'Read any feedback report',
    },
    {
      action: Action.delete,
      subject: ResourceType.FeedbackReport,
      slug: 'delete:feedback_report',
      riskLevel: RiskLevel.High,
      reason: 'Hard-delete a feedback report (separate from retention sweep)',
    },
    {
      action: Action.manage,
      subject: ResourceType.FeedbackReport,
      slug: 'manage:feedback_report',
      riskLevel: RiskLevel.High,
      reason: 'Full administrative control over feedback reports',
    },
    {
      action: Action.read,
      subject: ResourceType.FeedbackSinkDispatch,
      slug: 'read:feedback_sink_dispatch',
      riskLevel: RiskLevel.Medium,
      reason: 'Read sink-dispatch audit trail',
    },

    // ─── SafeHttpPolicy ─────────────────────────────────────
    {
      action: Action.read,
      subject: ResourceType.SafeHttpPolicy,
      slug: 'read:safe_http_policy',
      riskLevel: RiskLevel.Medium,
      reason: 'View the outbound HTTP SSRF policy',
    },
    {
      action: Action.manage,
      subject: ResourceType.SafeHttpPolicy,
      slug: 'manage:safe_http_policy',
      riskLevel: RiskLevel.Critical,
      reason:
        'Manage the outbound HTTP SSRF policy — timeouts, redirect limits, strict mode, and host/CIDR allow/block lists',
    },

    // --- Webhook Subscriptions ─────────────────────────────────────
    {
      action: Action.manage,
      subject: ResourceType.WebhookSubscription,
      conditions: { createdById: '{{ user.id }}' },
      slug: 'manage:webhook_subscription:own',
      riskLevel: RiskLevel.Medium,
      reason: 'Manage own webhook subscriptions',
    },
    {
      action: Action.read,
      subject: ResourceType.WebhookSubscription,
      conditions: { createdById: '{{ user.id }}' },
      slug: 'read:webhook_subscription:own',
      riskLevel: RiskLevel.Low,
      reason: 'View own webhook subscriptions',
    },

    // --- Audit Log ──────────────────────────────────────────
    // Read-only by design — there is no mutation API for audit rows.
    {
      action: Action.read,
      subject: ResourceType.AuditLog,
      slug: 'read:audit_log',
      riskLevel: RiskLevel.High,
      reason: 'View the persisted audit trail',
    },

    // --- Quotas ─────────────────────────────────────────────
    {
      action: Action.manage,
      subject: ResourceType.Quota,
      slug: 'manage:quota',
      riskLevel: RiskLevel.High,
      reason: 'Manage operational quotas',
    },
    {
      action: Action.read,
      subject: ResourceType.Quota,
      slug: 'read:quota',
      riskLevel: RiskLevel.Medium,
      reason: 'View operational quotas',
    },
    {
      action: Action.read,
      subject: ResourceType.Quota,
      conditions: { householdId: '{{ householdId }}' },
      slug: 'read:quota:household',
      riskLevel: RiskLevel.Low,
      reason: "View this household's own and per-member quota caps",
    },
    {
      action: Action.manage,
      subject: ResourceType.Quota,
      conditions: { scope: 'HouseholdMember', householdId: '{{ householdId }}' },
      slug: 'manage:quota:household_member',
      riskLevel: RiskLevel.Low,
      reason: 'Sub-allocate member quotas within own household',
    },
  ];

  const permissionsBySlug: Record<string, Permission> = {};
  for (const perm of permissionsToCreate) {
    const created = await prisma.permission.upsert({
      where: { slug: perm.slug },
      update: {
        action: perm.action,
        subject: perm.subject,
        fields: perm.fields || [],
        conditions: perm.conditions ? perm.conditions : {},
        reason: perm.reason,
        // Seed is authoritative: reclassification overwrites on re-run (#60 —
        // the admin reclassification flow is out of scope, so seed-wins is
        // the only writer).
        riskLevel: perm.riskLevel,
      },
      create: {
        action: perm.action,
        subject: perm.subject,
        fields: perm.fields || [],
        conditions: perm.conditions ? perm.conditions : {},
        reason: perm.reason,
        riskLevel: perm.riskLevel,
        slug: perm.slug,
      },
    });
    permissionsBySlug[perm.slug] = created;
  }
  logger.log(`✅ Default permissions created.`);

  // ============================================
  // SYSTEM ROLES
  // ============================================
  logger.log('📋 Creating roles...');

  const rolesToCreate = [
    // System
    { name: SystemRole.Owner, description: 'System owner with absolute control' },
    { name: SystemRole.Admin, description: 'Full access to all system functions' },
    { name: SystemRole.Moderator, description: 'Can moderate content but cannot change system settings' },
    { name: SystemRole.User, description: 'Standard user account' },

    // Household
    { name: SystemRole.HouseholdOwner, description: 'Owner of a household with full control' },
    { name: SystemRole.HouseholdAdmin, description: 'Can manage household settings and members' },
    { name: SystemRole.HouseholdMember, description: 'Regular household member' },
    { name: SystemRole.HouseholdGuest, description: 'Limited access household guest' },

    // Event
    { name: SystemRole.EventHost, description: 'Host of an event with permissions to manage it' },
    { name: SystemRole.EventCoHost, description: 'Co-Host of an event' },
    { name: SystemRole.EventOrganizer, description: 'Logistics focused, no moderation' },
    { name: SystemRole.EventModerator, description: 'Moderator scoped to an event' },
    { name: SystemRole.EventParticipant, description: 'Active participant in an event' },

    // is there are difference?
    { name: SystemRole.EventGuest, description: 'Limited access event guest' },
    { name: SystemRole.EventSpectator, description: 'Read-only observer for an event' },
  ];

  const rolesByName: Record<string, Role> = {};
  for (const roleData of rolesToCreate) {
    const created = await prisma.role.upsert({
      where: { name: roleData.name },
      update: { description: roleData.description, isSystem: true },
      create: { name: roleData.name, description: roleData.description, isSystem: true },
    });
    rolesByName[roleData.name] = created;
  }
  logger.log('✅ Roles created.');

  const resources = new Set([...Object.values(ResourceType), 'all']);

  // Helper to map permissions to roles
  const assignPermissions = async (roleName: string, slugs: string[]) => {
    const roleId: string = rolesByName[roleName].id;
    for (const slug of slugs) {
      const permission = permissionsBySlug[slug];
      if (!permission) {
        throw new Error(`Permission with slug ${slug} not found for role ${roleName}`);
      }

      if (!resources.has(permission.subject)) {
        throw new Error(`Permission subject ${permission.subject} is not a valid resource type for role ${roleName}`);
      }

      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId,
          permissionId: permission.id,
        },
      });
    }
  };

  logger.log('📋 Assigning permissions to roles...');

  // OWNER
  await assignPermissions(SystemRole.Owner, ['manage:all']);

  // ADMIN
  const allPermsExceptManageAll = permissionsToCreate.map((p) => p.slug).filter((s) => s !== 'manage:all');
  await assignPermissions(SystemRole.Admin, allPermsExceptManageAll);

  // MODERATOR
  await assignPermissions(SystemRole.Moderator, [
    'manage:content:moderate',
    'read:public_content',

    // audit
    'read:audit_log',

    // event
    'read:event',
    'delete:event:moderate',
    'update:event',

    // feedback
    'read:feedback_report',
    'read:feedback_sink_dispatch',

    // game
    'read:game_collection',
    'read:game',
    'update:game',
    'delete:game_play_session',
    'read:game_play_session',

    // household
    'read:household',
    'read:households',

    'read:safe_http_policy',
    'read:user:profile',

    // Media
    'read:media_contribution',
    'read:media_object:public',
    'update:media_contribution:moderate',
  ]);

  // STANDARD USER
  await assignPermissions(SystemRole.User, [
    // event
    'create:event',

    // feedback
    'create:feedback_report',
    'read:feedback_report:own',

    // friendships
    'create:friendship',
    'read:friendships:own',
    'update:friendship:own',
    'delete:friendship:own',
    'read:event:friends',
    'read:households:friends',
    'read:household_member:friends',

    // game
    'create:game',
    'read:game',
    'read:job',

    // game collection
    'create:game_collection',
    'delete:game_collection',
    'read:game_collection',
    'read:game_collection:household',
    'read:game_collection:friends',
    'read:game_collection:public',
    'update:game_collection',

    // household
    'create:household',
    'read:households',

    // game session
    'read:game_play_session',
    'create:session_player:join',

    // media
    'create:media_contribution',
    'create:media_object',
    'delete:media_object:own',
    'read:media_object:own',
    'read:media_object:public',
    'update:media_contribution:reclaim',
    'update:media_object:own',

    // platform
    'read:platform_game',
    'read:platform',

    // rule variant
    'create:rule_variant',
    'update:rule_variant',
    'delete:rule_variant',

    // user
    'create:user_game_customization',
    'delete:user_game_customization',
    'read:user:profile',
    'update:user_game_customization',
    'update:user:profile:own',

    // webhook
    'manage:webhook_subscription:own',
    'read:webhook_subscription:own',
  ]);

  const householdOwnerPermissions = [
    'create:event_game',
    'create:event_invite',
    'create:event_occurrence',
    'create:event',
    'create:game_play_session',
    'create:household_invite',
    'create:household_role',
    'create:play_record',
    'create:rule_variant',
    'delete:event_game',
    'delete:event_occurrence',
    'manage:quota:household_member',
    'create:household_member:join',
    'delete:household_member:leave',
    'delete:event',
    'read:quota:household',
    'delete:game_play_session',
    'delete:household',
    'delete:rule_variant',
    'manage:attendee_game_list',
    'manage:event_attendee',
    'manage:household_member',
    'read:attendee_game_list',
    'read:event_availability_vote',
    'read:event_game_nomination',
    'read:event_game_vote',
    'read:event_game',
    'read:event_occurrence',
    'read:event_policy',
    'read:game_collection',
    'read:household',
    'read:households',
    'read:household_member',
    'update:event_game_nomination:resolve',
    'update:event_occurrence:cancel',
    'update:event_occurrence:confirm',
    'update:event_occurrence:decline',
    'update:event_occurrence',
    // this should only apply when the event is associated with the household -- maybe? perhaps not at all
    'update:event_policy',
    'update:event',
    'update:game_play_session',
    'update:household',
    'update:household_role:transfer-ownership',
    'update:rule_variant',
  ];

  // HOUSEHOLD OWNER
  await assignPermissions(SystemRole.HouseholdOwner, householdOwnerPermissions);

  // The Admin list is DERIVED from the owner list, so every Owner-only slug has
  // to be named here or it is granted to HouseholdAdmin silently, with no
  // compile-time signal. `update:household_role:transfer-ownership` is the gate
  // that keeps owner transitions (both directions) out of #156's change-role
  // endpoint; an Admin holding it would defeat that separation entirely.
  const disallowedHouseholdAdminPermissions = ['delete:household', 'update:household_role:transfer-ownership'];
  const householdAdminPermissions = householdOwnerPermissions.filter(
    (perm) => !disallowedHouseholdAdminPermissions.includes(perm),
  );
  // HOUSEHOLD ADMIN
  await assignPermissions(SystemRole.HouseholdAdmin, householdAdminPermissions);

  // HOUSEHOLD MEMBER
  await assignPermissions(SystemRole.HouseholdMember, [
    'create:game_play_session',
    'create:play_record',
    'create:rule_variant',
    'create:session_player:join',
    'read:attendee_game_list',
    'read:event_attendee',
    'read:event_availability_vote',
    'read:event_game_nomination',
    'read:event_game_vote',
    'read:event_game',
    'read:household_member',
    'delete:household_member:leave',
    'read:event_occurrence',
    'read:event_policy',
    'read:event:participant',
    'read:game_collection',
    'read:game_play_session',
    'read:household',
    'read:households',
  ]);

  // HOUSEHOLD GUEST
  await assignPermissions(SystemRole.HouseholdGuest, [
    'create:session_player:join',
    'delete:household_member:leave',
    'read:event:participant',
    'read:game_play_session',
    'read:household',
    'read:household_member',
    'read:households',
  ]);

  const eventHostPermissions = [
    'create:event_invite',
    'create:game_play_session',
    'create:play_record',
    'delete:event',
    'delete:game_play_session',
    'manage:event_attendee',
    'read:event_attendee',
    'read:event:participant',
    'read:game_play_session',
    'update:event_attendee:status',
    'update:event:status:archive-event',
    'update:event:status:cancel-event',
    'update:event',
    'update:game_play_session',

    // Occurrences
    'create:event_occurrence',
    'delete:event_occurrence',
    'read:event_occurrence',
    'update:event_occurrence:cancel',
    'update:event_occurrence:confirm',
    'update:event_occurrence:decline',
    'update:event_occurrence',

    // Availability
    'create:event_availability_vote',
    'read:event_availability_vote',

    // Nominations
    'create:event_game_nomination',
    'read:event_game_nomination',
    'update:event_game_nomination:approve',
    'update:event_game_nomination:reject',
    'update:event_game_nomination:resolve',
    'update:event_game_nomination:withdraw',

    // Game votes
    'create:event_game_vote',
    'read:event_game_vote',

    // Event games
    'create:event_game',
    'delete:event_game',
    'read:event_game',

    // Game lists
    'create:attendee_game_list',
    'delete:attendee_game_list',
    'manage:attendee_game_list',
    'read:attendee_game_list',

    // Policy
    'read:event_policy',
    'update:event_policy',
  ];

  // EVENT HOST
  await assignPermissions(SystemRole.EventHost, eventHostPermissions);

  const disallowedCoHostPermissions = ['delete:event'];
  const eventCohostPermissions = eventHostPermissions.filter((perm) => !disallowedCoHostPermissions.includes(perm));

  // EVENT CO-HOST
  await assignPermissions(SystemRole.EventCoHost, eventCohostPermissions);

  // EVENT ORGANIZER
  await assignPermissions(SystemRole.EventOrganizer, [
    'create:attendee_game_list',
    'create:event_availability_vote',
    'create:event_invite',
    'create:event_occurrence',
    'delete:attendee_game_list',
    'manage:event_attendee',
    'read:attendee_game_list',
    'read:event_attendee',
    'read:event_availability_vote',
    'read:event_game_nomination',
    'read:event_game_vote',
    'read:event_game',
    'read:event_occurrence',
    'read:event_policy',
    'read:event:participant',
    'update:event_attendee:status',
    'update:event_occurrence',
    'update:event',
  ]);

  // EVENT MODERATOR
  await assignPermissions(SystemRole.EventModerator, [
    'delete:event_game',
    'delete:game_play_session',
    'manage:attendee_game_list',
    'manage:event_attendee',
    'read:attendee_game_list',
    'read:event_attendee',
    'read:event_availability_vote',
    'read:event_game_nomination',
    'read:event_game_vote',
    'read:event_game',
    'read:event_occurrence',
    'read:event_policy',
    'read:event:participant',
    'update:event_attendee:status',
    'update:event_game_nomination:resolve',
    'update:event_occurrence:cancel',
    'update:event_occurrence',
    'update:event',
  ]);

  // EVENT PARTICIPANT
  await assignPermissions(SystemRole.EventParticipant, [
    'create:attendee_game_list',
    'create:event_availability_vote',
    'create:event_game_nomination',
    'create:event_game_vote',
    'create:event_game',
    'create:event_invite',
    'create:game_play_session',
    'create:media:upload',
    'create:play_record',
    'create:rule_variant',
    'create:session_player:join',
    'delete:attendee_game_list',
    'read:attendee_game_list',
    'read:event_attendee',
    'read:event_availability_vote',
    'read:event_game_nomination',
    'read:event_game_vote',
    'read:event_game',
    'read:event_occurrence',
    'read:event_policy',
    'read:event:participant',
    'read:game_collection',
    'read:game_play_session',
    'update:event_attendee:status:self',
    'update:event_game_nomination:withdraw',
    'update:game_play_session',
  ]);

  // EVENT GUEST
  await assignPermissions(SystemRole.EventGuest, [
    'create:attendee_game_list',
    'create:event_availability_vote',
    'create:session_player:join',
    'delete:attendee_game_list',
    'read:attendee_game_list',
    'read:event_attendee',
    'read:event_availability_vote',
    'read:event_game_nomination',
    'read:event_game_vote',
    'read:event_game',
    'read:event_occurrence',
    'read:event_policy',
    'read:event:participant',
    'read:game_play_session',
    'update:event_attendee:status:self',
  ]);

  // EVENT SPECTATOR
  await assignPermissions(SystemRole.EventSpectator, [
    'create:session_player:observer:join',
    'read:attendee_game_list',
    'read:event_attendee',
    'read:event_availability_vote',
    'read:event_game_nomination',
    'read:event_game_vote',
    'read:event_game',
    'read:event_occurrence',
    'read:event_policy',
    'read:event:participant',
    'read:game_play_session',
  ]);

  logger.log('✅ All permissions assigned.');
}
