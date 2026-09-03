import { SystemRole } from '../client';
import { assertRolePermissionCatalog } from './catalog-integrity';
import { PERMISSION_CATALOG, type PermissionSlug } from './permission.catalog';

/**
 * Role → slug assignments. Three lists are DERIVED rather than enumerated,
 * exactly as the seed always computed them:
 *
 * - `Admin` = every slug except `manage:all` (retiring this blanket
 *   derivation for an enumerated list is #244, not this catalog's concern);
 * - `HouseholdAdmin` = the owner list minus `HOUSEHOLD_OWNER_ONLY`;
 * - `EventCoHost` = the host list minus `EVENT_HOST_ONLY`.
 *
 * Because those lists are derived, every Owner-/Host-only slug has to be
 * named in the exclusion, or it is granted to the derived role silently, with
 * no compile-time signal. `update:household_role:transfer-ownership` is the
 * gate that keeps owner transitions (both directions) out of #156's
 * change-role endpoint; an Admin holding it would defeat that separation.
 *
 * Insertion order is the seed's assignment order.
 */

const HOUSEHOLD_OWNER: readonly PermissionSlug[] = [
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
  // Plugin unit administration (#59 C4): household owners AND admins —
  // deliberately absent from every non-admin household role.
  'manage:plugin:household',
  'read:plugin:household',
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

const HOUSEHOLD_OWNER_ONLY: readonly PermissionSlug[] = [
  'delete:household',
  'update:household_role:transfer-ownership',
];

const EVENT_HOST: readonly PermissionSlug[] = [
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

const EVENT_HOST_ONLY: readonly PermissionSlug[] = ['delete:event'];

export const ROLE_PERMISSION_CATALOG: Readonly<Record<SystemRole, readonly PermissionSlug[]>> = {
  [SystemRole.Owner]: ['manage:all'],
  [SystemRole.Admin]: PERMISSION_CATALOG.map((permission) => permission.slug).filter((slug) => slug !== 'manage:all'),
  [SystemRole.Moderator]: [
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
  ],
  [SystemRole.User]: [
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
  ],
  [SystemRole.HouseholdOwner]: HOUSEHOLD_OWNER,
  [SystemRole.HouseholdAdmin]: HOUSEHOLD_OWNER.filter((slug) => !HOUSEHOLD_OWNER_ONLY.includes(slug)),
  [SystemRole.HouseholdMember]: [
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
  ],
  [SystemRole.HouseholdGuest]: [
    'create:session_player:join',
    'delete:household_member:leave',
    'read:event:participant',
    'read:game_play_session',
    'read:household',
    'read:household_member',
    'read:households',
  ],
  [SystemRole.EventHost]: EVENT_HOST,
  [SystemRole.EventCoHost]: EVENT_HOST.filter((slug) => !EVENT_HOST_ONLY.includes(slug)),
  [SystemRole.EventOrganizer]: [
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
  ],
  [SystemRole.EventModerator]: [
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
  ],
  [SystemRole.EventParticipant]: [
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
  ],
  [SystemRole.EventGuest]: [
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
  ],
  [SystemRole.EventSpectator]: [
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
  ],
};

assertRolePermissionCatalog(ROLE_PERMISSION_CATALOG, PERMISSION_CATALOG);
