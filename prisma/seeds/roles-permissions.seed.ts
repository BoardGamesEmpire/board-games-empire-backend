import { Action, PrismaClient, ResourceType, SystemRole } from '@bge/database';
import type { Logger } from '@nestjs/common';

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

  const permissionsToCreate = [
    // --- Global Admin/Owner ---
    { action: Action.manage, subject: 'all', slug: 'manage:all', reason: 'Unrestricted access for Owner' },
    { action: Action.manage, subject: 'all', slug: 'manage:content:moderate', reason: 'Moderate app content' },
    { action: Action.read, subject: 'all', slug: 'read:public_content', reason: 'View public content' },

    // --- App Level / User ---
    // TODO: consider the ability to block other users from viewing your profile, etc.
    { action: Action.read, subject: ResourceType.UserProfile, slug: 'read:user:profile', reason: 'View user profiles' },
    {
      action: Action.update,
      subject: ResourceType.UserProfile,
      conditions: { userId: '{{ user.id }}' },
      slug: 'update:user:profile:own',
      reason: 'Update own profile',
    },

    // --- Friendships ---
    // Self-management: the acting user is a participant (requester or addressee).
    {
      action: Action.create,
      subject: ResourceType.Friendship,
      conditions: { requesterId: '{{ user.id }}' },
      slug: 'create:friendship',
      reason: 'Send a friend request',
    },
    {
      action: Action.read,
      subject: ResourceType.Friendship,
      conditions: { OR: [{ requesterId: '{{ user.id }}' }, { addresseeId: '{{ user.id }}' }] },
      slug: 'read:friendships:own',
      reason: 'View your own friendships and requests',
    },
    {
      action: Action.update,
      subject: ResourceType.Friendship,
      conditions: { OR: [{ requesterId: '{{ user.id }}' }, { addresseeId: '{{ user.id }}' }] },
      slug: 'update:friendship:own',
      reason: 'Respond to, withdraw, or block a friendship you are part of',
    },
    {
      action: Action.delete,
      subject: ResourceType.Friendship,
      conditions: { OR: [{ requesterId: '{{ user.id }}' }, { addresseeId: '{{ user.id }}' }] },
      slug: 'delete:friendship:own',
      reason: 'Remove a friendship you are part of',
    },
    // Friend visibility: read resources exposed to friends by their owner.
    {
      action: Action.read,
      subject: ResourceType.Event,
      conditions: { visibility: 'Friends', createdBy: acceptedFriendOfActingUser },
      slug: 'read:event:friends',
      reason: "View a friend's friends-visible events",
    },
    {
      action: Action.read,
      subject: ResourceType.Household,
      conditions: { visibility: 'Friends', members: { some: { user: acceptedFriendOfActingUser } } },
      slug: 'read:households:friends',
      reason: "View a friend's friends-visible households",
    },

    // --- Games ---
    { action: Action.read, subject: ResourceType.Game, slug: 'read:game', reason: 'View games' },
    { action: Action.read, subject: ResourceType.Job, slug: 'read:job', reason: 'View import/system job status' },
    { action: Action.create, subject: ResourceType.Game, slug: 'create:game', reason: 'Create games' },
    { action: Action.update, subject: ResourceType.Game, slug: 'update:game', reason: 'Update games' },
    { action: Action.delete, subject: ResourceType.Game, slug: 'delete:game', reason: 'Delete games' },

    {
      action: Action.update,
      subject: ResourceType.Game,
      slug: 'update:game:own',
      reason: 'Update own games',
      conditions: { createdById: '{{ user.id }}' },
    },
    {
      action: Action.delete,
      subject: ResourceType.Game,
      slug: 'delete:game:own',
      reason: 'Delete own games',
      conditions: { createdById: '{{ user.id }}' },
    },

    // --- PlatformGame ---
    {
      action: Action.read,
      subject: ResourceType.PlatformGame,
      slug: 'read:platform_game',
      reason: 'View platform-specific game entries',
    },
    {
      action: Action.create,
      subject: ResourceType.PlatformGame,
      slug: 'create:platform_game',
      reason: 'Create a platform-specific game entry (import pipelines)',
    },
    {
      action: Action.update,
      subject: ResourceType.PlatformGame,
      slug: 'update:platform_game',
      reason: 'Update platform-specific game capabilities or overrides',
    },
    {
      action: Action.delete,
      subject: ResourceType.PlatformGame,
      slug: 'delete:platform_game',
      reason: 'Remove a platform-specific game entry',
    },

    // --- Platform ---
    {
      action: Action.read,
      subject: ResourceType.Platform,
      slug: 'read:platform',
      reason: 'View platforms',
    },
    {
      action: Action.create,
      subject: ResourceType.Platform,
      slug: 'create:platform',
      reason: 'Create platforms',
    },
    {
      action: Action.update,
      subject: ResourceType.Platform,
      slug: 'update:platform',
      reason: 'Update platforms',
    },
    {
      action: Action.delete,
      subject: ResourceType.Platform,
      slug: 'delete:platform',
      reason: 'Delete platforms',
    },

    // ─── EventOccurrence ────────────────────────────────
    {
      action: Action.read,
      subject: ResourceType.EventOccurrence,
      slug: 'read:event_occurrence',
      reason: 'View event occurrences',
    },
    {
      action: Action.create,
      subject: ResourceType.EventOccurrence,
      slug: 'create:event_occurrence',
      reason: 'Add occurrences to an event',
    },
    {
      action: Action.update,
      subject: ResourceType.EventOccurrence,
      slug: 'update:event_occurrence',
      reason: 'Update occurrence details (label, date, location)',
    },
    {
      action: Action.delete,
      subject: ResourceType.EventOccurrence,
      slug: 'delete:event_occurrence',
      reason: 'Remove an occurrence from an event',
    },
    {
      action: Action.update,
      subject: ResourceType.EventOccurrence,
      slug: 'update:event_occurrence:confirm',
      reason: 'Confirm a proposed occurrence (Proposed → Confirmed)',
    },
    {
      action: Action.update,
      subject: ResourceType.EventOccurrence,
      slug: 'update:event_occurrence:decline',
      reason: 'Decline a proposed occurrence (Proposed → Declined)',
    },
    {
      action: Action.update,
      subject: ResourceType.EventOccurrence,
      slug: 'update:event_occurrence:cancel',
      reason: 'Cancel a confirmed occurrence (Confirmed → Cancelled)',
    },

    // ─── EventAvailabilityVote ──────────────────────────
    {
      action: Action.read,
      subject: ResourceType.EventAvailabilityVote,
      slug: 'read:event_availability_vote',
      reason: 'View availability votes and summary',
    },
    {
      action: Action.create,
      subject: ResourceType.EventAvailabilityVote,
      conditions: { attendee: { userId: '{{ user.id }}' } },
      slug: 'create:event_availability_vote',
      reason: 'Submit or update your availability vote on a proposed occurrence',
    },

    // ─── EventAttendee ──────────────────────────────────
    {
      action: Action.read,
      subject: ResourceType.EventAttendee,
      conditions: { event: { id: '{{ eventId }}' } },
      slug: 'read:event_attendee',
      reason: 'View event attendees',
    },
    {
      action: Action.update,
      subject: ResourceType.EventAttendee,
      fields: ['status', 'notes'],
      conditions: { userId: '{{ user.id }}' },
      slug: 'update:event_attendee:status:self',
      reason: 'Update own RSVP status',
    },
    {
      action: Action.update,
      subject: ResourceType.EventAttendee,
      fields: ['status', 'notes'],
      conditions: { event: { id: '{{ eventId }}' } },
      slug: 'update:event_attendee:status',
      reason: 'Update any attendee status within an event (host-managed)',
    },

    // ─── EventGameNomination ────────────────────────────
    {
      action: Action.read,
      subject: ResourceType.EventGameNomination,
      slug: 'read:event_game_nomination',
      reason: 'View game nominations',
    },
    {
      action: Action.create,
      subject: ResourceType.EventGameNomination,
      slug: 'create:event_game_nomination',
      reason: 'Nominate a game for the event',
    },
    {
      action: Action.update,
      subject: ResourceType.EventGameNomination,
      conditions: { nominatedBy: { userId: '{{ user.id }}' } },
      slug: 'update:event_game_nomination:withdraw',
      reason: 'Withdraw your own nomination',
    },
    {
      action: Action.update,
      subject: ResourceType.EventGameNomination,
      slug: 'update:event_game_nomination:resolve',
      reason: 'Resolve a nomination (tally votes)',
    },
    {
      action: Action.update,
      subject: ResourceType.EventGameNomination,
      slug: 'update:event_game_nomination:approve',
      reason: 'Approve a nomination (HostApproval mode)',
    },
    {
      action: Action.update,
      subject: ResourceType.EventGameNomination,
      slug: 'update:event_game_nomination:reject',
      reason: 'Reject a nomination (HostApproval mode)',
    },

    // ─── EventGameVote ──────────────────────────────────
    {
      action: Action.read,
      subject: ResourceType.EventGameVote,
      slug: 'read:event_game_vote',
      reason: 'View game nomination votes',
    },
    {
      action: Action.create,
      subject: ResourceType.EventGameVote,
      conditions: { attendee: { userId: '{{ user.id }}' } },
      slug: 'create:event_game_vote',
      reason: 'Cast or update your vote on a nomination',
    },

    // ─── EventGame ──────────────────────────────────────
    {
      action: Action.read,
      subject: ResourceType.EventGame,
      slug: 'read:event_game',
      reason: 'View the event game lineup',
    },
    {
      action: Action.create,
      subject: ResourceType.EventGame,
      slug: 'create:event_game',
      reason: 'Directly add a game to the event lineup',
    },
    {
      action: Action.delete,
      subject: ResourceType.EventGame,
      slug: 'delete:event_game',
      reason: 'Remove a game from the event lineup',
    },

    // ─── EventAttendeeGameList ──────────────────────────
    {
      action: Action.read,
      subject: ResourceType.EventAttendeeGameList,
      slug: 'read:attendee_game_list',
      reason: "View an attendee's available game list",
    },
    {
      action: Action.create,
      subject: ResourceType.EventAttendeeGameList,
      conditions: { attendee: { userId: '{{ user.id }}' } },
      slug: 'create:attendee_game_list',
      reason: 'Add a game to your own available game list',
    },
    {
      action: Action.delete,
      subject: ResourceType.EventAttendeeGameList,
      conditions: { attendee: { userId: '{{ user.id }}' } },
      slug: 'delete:attendee_game_list',
      reason: 'Remove a game from your own available game list',
    },
    {
      action: Action.manage,
      subject: ResourceType.EventAttendeeGameList,
      slug: 'manage:attendee_game_list',
      reason: "Manage any attendee's available game list",
    },

    // ─── EventPolicy ────────────────────────────────────
    {
      action: Action.read,
      subject: ResourceType.EventPolicy,
      slug: 'read:event_policy',
      reason: 'View event policy configuration',
    },
    {
      action: Action.update,
      subject: ResourceType.EventPolicy,
      slug: 'update:event_policy',
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
      reason: "View your friends' collections",
    },
    {
      action: Action.read,
      subject: ResourceType.GameCollection,
      conditions: { deletedAt: null, visibility: 'Public' },
      slug: 'read:game_collection:public',
      reason: 'View public collections',
    },
    {
      action: Action.create,
      subject: ResourceType.GameCollection,
      conditions: { userId: '{{ user.id }}' },
      slug: 'create:game_collection',
      reason: 'Add game to collection',
    },
    {
      action: Action.update,
      subject: ResourceType.GameCollection,
      conditions: { userId: '{{ user.id }}' },
      slug: 'update:game_collection',
      reason: 'Update game in collection',
    },
    {
      action: Action.delete,
      subject: ResourceType.GameCollection,
      conditions: { userId: '{{ user.id }}' },
      slug: 'delete:game_collection',
      reason: 'Remove game from collection',
    },

    // --- Game Gateway ---
    {
      action: Action.read,
      subject: ResourceType.GameGateway,
      slug: 'read:game_gateway',
      reason: 'View game gateway connections',
    },
    {
      action: Action.create,
      subject: ResourceType.GameGateway,
      slug: 'create:game_gateway',
      reason: 'Create game gateway connections',
    },
    {
      action: Action.update,
      subject: ResourceType.GameGateway,
      slug: 'update:game_gateway',
      reason: 'Update game gateway connections',
    },
    {
      action: Action.delete,
      subject: ResourceType.GameGateway,
      slug: 'delete:game_gateway',
      reason: 'Delete game gateway connections',
    },

    // --- Households ---
    { action: Action.create, subject: ResourceType.Household, slug: 'create:household', reason: 'Create a household' },
    {
      action: Action.read,
      subject: ResourceType.Household,
      conditions: {
        members: { some: { userId: '{{ user.id }}' } },
      },
      slug: 'read:households',
      reason: 'View households',
    },
    {
      action: Action.read,
      subject: ResourceType.Household,
      conditions: {
        id: '{{ householdId }}',
      },
      slug: 'read:household',
      reason: 'View household details',
    },

    // TODO: We should probably have more granular permissions here to allow for different levels of household management, etc. Otherwise, any member could update the household details
    {
      action: Action.update,
      subject: ResourceType.Household,
      conditions: {
        id: '{{ householdId }}',
        members: { some: { userId: '{{ user.id }}' } },
      },
      slug: 'update:household',
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
      reason: 'Delete a household',
    },
    {
      action: Action.manage,
      subject: ResourceType.HouseholdMember,
      conditions: {
        householdId: '{{ householdId }}',
        members: {
          some: {
            userId: '{{ user.id }}',
            role: { role: { name: { in: ['HouseholdOwner', 'HouseholdAdmin'] } } },
          },
        },
      },
      slug: 'manage:household_member',
      reason: 'Manage household members',
    },
    {
      action: Action.create,
      subject: ResourceType.HouseholdRole,
      conditions: {
        householdId: '{{ householdId }}',
        members: {
          some: {
            userId: '{{ user.id }}',
            role: { role: { name: { in: ['HouseholdOwner', 'HouseholdAdmin'] } } },
          },
        },
      },
      slug: 'create:household_role',
      reason: 'Create household roles',
    },

    // TODO: maybe defer to a household policy?
    {
      action: Action.create,
      subject: ResourceType.Invite,
      conditions: {
        householdId: '{{ householdId }}',
        members: {
          some: {
            userId: '{{ user.id }}',
            role: { role: { name: { in: ['HouseholdOwner', 'HouseholdAdmin'] } } },
          },
        },
      },
      slug: 'create:household_invite',
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
      reason: 'Join household',
    },

    // --- Events ---
    { action: Action.create, subject: ResourceType.Event, slug: 'create:event', reason: 'Create an event' },

    // TODO household specific event permissions? i.e read:household_event etc
    {
      action: Action.read,
      subject: ResourceType.Event,
      slug: 'read:event',
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
      reason: 'Update an event',
    },
    {
      action: Action.delete,
      subject: ResourceType.Event,
      conditions: { createdById: '{{ user.id }}' },
      slug: 'delete:event',
      reason: 'Delete an event as creator',
    },

    // TODO: this needs conditions to validate moderator role and scope
    {
      action: Action.delete,
      subject: ResourceType.Event,
      slug: 'delete:event:moderate',
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
      reason: 'Invite to event',
    },
    {
      action: Action.manage,
      subject: ResourceType.EventAttendee,
      conditions: { eventId: '{{ eventId }}' },
      slug: 'manage:event_attendee',
      reason: 'Manage event participants',
    },

    // --- Game Sessions ---
    {
      action: Action.create,
      subject: ResourceType.GamePlayResult,
      slug: 'create:play_record',
      reason: 'Create a play record',
    },
    {
      action: Action.read,
      subject: ResourceType.GamePlaySession,
      slug: 'read:game_play_session',
      reason: 'View a game session',
    },
    {
      action: Action.create,
      subject: ResourceType.GamePlaySession,
      slug: 'create:game_play_session',
      reason: 'Create a game session',
    },
    {
      action: Action.update,
      subject: ResourceType.GamePlaySession,
      slug: 'update:game_play_session',
      reason: 'Update a game session',
    },
    {
      action: Action.delete,
      subject: ResourceType.GamePlaySession,
      slug: 'delete:game_play_session',
      reason: 'Delete a game session',
    },
    {
      action: Action.create,
      subject: ResourceType.SessionPlayer,
      slug: 'create:session_player:join',
      reason: 'Join a game session',
    },
    {
      action: Action.create,
      subject: ResourceType.SessionPlayer,
      slug: 'create:session_player:observer:join',
      reason: 'Join a game session as observer',
    },

    // --- Rule Variants ---
    // TODO: own rules vs admin/moderator
    {
      action: Action.create,
      subject: ResourceType.RuleVariant,
      slug: 'create:rule_variant',
      reason: 'Create rule variant',
    },
    {
      action: Action.update,
      subject: ResourceType.RuleVariant,
      conditions: {
        createdById: '{{ user.id }}',
      },
      slug: 'update:rule_variant',
      reason: 'Update rule variant',
    },
    {
      action: Action.delete,
      subject: ResourceType.RuleVariant,
      conditions: {
        createdById: '{{ user.id }}',
      },
      slug: 'delete:rule_variant',
      reason: 'Delete rule variant',
    },

    // --- Media ---
    { action: Action.create, subject: ResourceType.Media, slug: 'create:media:upload', reason: 'Upload media' },

    // ─── MediaObject ────────────────────────────────────────
    {
      action: Action.create,
      subject: ResourceType.MediaObject,
      slug: 'create:media_object',
      reason: 'Upload a media object',
    },
    {
      action: Action.read,
      subject: ResourceType.MediaObject,
      conditions: { ownerId: '{{ user.id }}' },
      slug: 'read:media_object:own',
      reason: 'View own media objects',
    },
    {
      action: Action.read,
      subject: ResourceType.MediaObject,
      conditions: { visibility: 'Public' },
      slug: 'read:media_object:public',
      reason: 'View public media objects',
    },
    {
      action: Action.update,
      subject: ResourceType.MediaObject,
      conditions: { ownerId: '{{ user.id }}' },
      slug: 'update:media_object:own',
      reason: 'Update own media objects (publish/unpublish, attach/detach)',
    },
    {
      action: Action.delete,
      subject: ResourceType.MediaObject,
      conditions: { ownerId: '{{ user.id }}' },
      slug: 'delete:media_object:own',
      reason: 'Delete own media objects',
    },

    // ─── MediaContribution ──────────────────────────────────
    {
      action: Action.create,
      subject: ResourceType.MediaContribution,
      conditions: { contributedById: '{{ user.id }}' },
      slug: 'create:media_contribution',
      reason: 'Contribute own media to a game or event',
    },
    {
      action: Action.update,
      subject: ResourceType.MediaContribution,
      conditions: { contributedById: '{{ user.id }}' },
      slug: 'update:media_contribution:reclaim',
      reason: 'Reclaim own contribution before its deadline',
    },
    {
      action: Action.read,
      subject: ResourceType.MediaContribution,
      slug: 'read:media_contribution',
      reason: 'View contributions for moderation',
    },
    {
      action: Action.update,
      subject: ResourceType.MediaContribution,
      slug: 'update:media_contribution:moderate',
      reason: 'Approve or reject media contributions',
    },

    // --- Customization ---
    {
      action: Action.create,
      subject: ResourceType.UserGameCustomization,
      slug: 'create:user_game_customization',
      reason: 'Create customization',
    },
    {
      action: Action.update,
      subject: ResourceType.UserGameCustomization,
      conditions: {
        userId: '{{ user.id }}',
      },
      slug: 'update:user_game_customization',
      reason: 'Update customization',
    },
    {
      action: Action.delete,
      subject: ResourceType.UserGameCustomization,
      conditions: {
        userId: '{{ user.id }}',
      },
      slug: 'delete:user_game_customization',
      reason: 'Delete customization',
    },

    // ─── Feedback ───────────────────────────────────────────
    {
      action: Action.create,
      subject: ResourceType.FeedbackReport,
      slug: 'create:feedback_report',
      reason: 'Submit a feedback report',
    },
    {
      action: Action.read,
      subject: ResourceType.FeedbackReport,
      conditions: { userId: '{{ user.id }}' },
      slug: 'read:feedback_report:own',
      reason: 'Read own feedback reports',
    },
    {
      action: Action.read,
      subject: ResourceType.FeedbackReport,
      slug: 'read:feedback_report',
      reason: 'Read any feedback report',
    },
    {
      action: Action.delete,
      subject: ResourceType.FeedbackReport,
      slug: 'delete:feedback_report',
      reason: 'Hard-delete a feedback report (separate from retention sweep)',
    },
    {
      action: Action.manage,
      subject: ResourceType.FeedbackReport,
      slug: 'manage:feedback_report',
      reason: 'Full administrative control over feedback reports',
    },
    {
      action: Action.read,
      subject: ResourceType.FeedbackSinkDispatch,
      slug: 'read:feedback_sink_dispatch',
      reason: 'Read sink-dispatch audit trail',
    },

    // ─── SafeHttpPolicy ─────────────────────────────────────
    {
      action: Action.read,
      subject: ResourceType.SafeHttpPolicy,
      slug: 'read:safe_http_policy',
      reason: 'View the outbound HTTP SSRF policy',
    },
    {
      action: Action.manage,
      subject: ResourceType.SafeHttpPolicy,
      slug: 'manage:safe_http_policy',
      reason:
        'Manage the outbound HTTP SSRF policy — timeouts, redirect limits, strict mode, and host/CIDR allow/block lists',
    },

    // --- Webhook Subscriptions ─────────────────────────────────────
    {
      action: Action.manage,
      subject: ResourceType.WebhookSubscription,
      conditions: { createdById: '{{ user.id }}' },
      slug: 'manage:webhook_subscription:own',
      reason: 'Manage own webhook subscriptions',
    },
    {
      action: Action.read,
      subject: ResourceType.WebhookSubscription,
      conditions: { createdById: '{{ user.id }}' },
      slug: 'read:webhook_subscription:own',
      reason: 'View own webhook subscriptions',
    },

    // --- Audit Log ──────────────────────────────────────────
    // Read-only by design — there is no mutation API for audit rows.
    {
      action: Action.read,
      subject: ResourceType.AuditLog,
      slug: 'read:audit_log',
      reason: 'View the persisted audit trail',
    },

    // --- Quotas ─────────────────────────────────────────────
    { action: Action.manage, subject: ResourceType.Quota, slug: 'manage:quota', reason: 'Manage operational quotas' },
    { action: Action.read, subject: ResourceType.Quota, slug: 'read:quota', reason: 'View operational quotas' },
    {
      action: Action.read,
      subject: ResourceType.Quota,
      conditions: { householdId: '{{ householdId }}' },
      slug: 'read:quota:household',
      reason: "View this household's own and per-member quota caps",
    },
    {
      action: Action.manage,
      subject: ResourceType.Quota,
      conditions: { scope: 'HouseholdMember', householdId: '{{ householdId }}' },
      slug: 'manage:quota:household_member',
      reason: 'Sub-allocate member quotas within own household',
    },
  ];

  const permissionsBySlug: Record<string, any> = {};
  for (const perm of permissionsToCreate) {
    const created = await prisma.permission.upsert({
      where: { slug: perm.slug },
      update: {
        action: perm.action,
        subject: perm.subject,
        fields: perm.fields || [],
        conditions: perm.conditions ? perm.conditions : {},
        reason: perm.reason,
      },
      create: {
        action: perm.action,
        subject: perm.subject,
        fields: perm.fields || [],
        conditions: perm.conditions ? perm.conditions : {},
        reason: perm.reason,
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

  const rolesByName: Record<string, any> = {};
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
    'update:rule_variant',
  ];

  // HOUSEHOLD OWNER
  await assignPermissions(SystemRole.HouseholdOwner, householdOwnerPermissions);

  const disallowedHouseholdAdminPermissions = ['delete:household'];
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
    'read:event:participant',
    'read:game_play_session',
    'read:household',
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
