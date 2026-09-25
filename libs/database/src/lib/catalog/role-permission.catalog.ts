import { SystemRole } from '../client';
import { assertRolePermissionCatalog } from './catalog-integrity';
import { PERMISSION_CATALOG, type PermissionSlug } from './permission.catalog';

/**
 * Role → slug assignments. Two lists are DERIVED rather than enumerated:
 *
 * - `HouseholdAdmin` = the owner list minus `HOUSEHOLD_OWNER_ONLY`;
 * - `EventCoHost` = the host list minus `EVENT_HOST_ONLY`.
 *
 * `Admin` used to be a third — every slug except `manage:all` — and is now
 * written out. The derivation read as "an Admin can do everything except the
 * Owner-only wildcard"; what it actually produced was 77 grants templated on a
 * household or event that the `roles` pass never supplies, so they rendered to
 * clauses matching nothing, plus `manage:content:moderate`, an unconditioned
 * `manage` on `all` that made the inert 77 irrelevant by granting everything
 * anyway. Staff authority is now a list somebody chose (#244). The cost is
 * real and is the point: a new slug reaches `Admin` only when someone adds it
 * here, where before it arrived for free and unexamined.
 *
 * Staff roles AUGMENT `User`; they do not mirror it. Every signed-in actor is
 * provisioned with `User` and elevation adds a role rather than replacing one
 * (#410), so a slug `User` already holds adds nothing to `Admin` or
 * `Moderator`: abilities union across an actor's roles and a second identical
 * `can` is a no-op. The enumeration originally repeated all 43 of `User`'s
 * slugs, because the derivation it replaced was "every slug except
 * `manage:all`" and writing that out preserved its contents rather than
 * choosing them. They are gone. What is left on a staff role is only what an
 * ordinary user does NOT have, which is also what makes the list readable as a
 * statement of staff authority.
 *
 * The subtraction is safe only because `User` is held independently — see
 * `user-provisioning.service.ts`. An actor granted `Admin` WITHOUT `User` is
 * now LESS capable than an ordinary user, which is the trap #410 describes for
 * `Owner`, and the reason neither role is ever assigned alone.
 *
 * `update:game:own`/`delete:game:own` are the one change here that is NOT a
 * subtraction, and calling it a move would understate it. `Admin` was their
 * only holder, and `Admin`'s own unconditioned `update:game`/`delete:game`
 * subsumed them, so they granted nothing anywhere: no user could edit a game
 * they had created. Putting them on `User` is a deliberate EXPANSION — every
 * authenticated actor gains them — and it is the rule the domain already runs
 * on: an imported game is always public and server-owned, while a game a user
 * creates may be private and is theirs to edit or delete. `delete:game:own`
 * reaches a HARD delete (`game.service.ts`), guarded only by a count of live
 * collection rows; that is the creator's own row to destroy, but it is a real
 * capability and not bookkeeping. `Admin` keeps the unconditioned pair that
 * curating an install needs.
 *
 * Every other change is a removal, and none of them costs authority. The four
 * attendee-scoped event grants (`create:event_availability_vote`,
 * `create:event_game_vote`, `update:event_game_nomination:withdraw`,
 * `update:event_attendee:status:self`) are bound to the actor's OWN attendee
 * row: the event roles carry them for anyone who attends, and
 * `resolveActingAttendeeId` refuses a non-attendee before CASL is consulted. An
 * Admin attending as `EventSpectator` or `EventModerator` loses a vote it
 * should not have had — neither of those roles votes. `create:household_role`
 * and `delete:event` went the same way for a sharper reason: both are scoped
 * `{{ user.id }}` and both are already held by the role their own condition
 * demands — `HouseholdOwner`/`HouseholdAdmin` for the first, `EventHost` (which
 * an event's creator is seeded as) for the second — so each rendered a clause
 * identical to one the actor already had. `Admin` now carries no conditioned
 * slug at all, which is the shape a global role should have: a global role has
 * no scope coordinate, so anything it holds that binds to one is either inert
 * or a duplicate.
 *
 * Because those lists are derived, every Owner-/Host-only slug has to be
 * named in the exclusion, or it is granted to the derived role silently, with
 * no compile-time signal. `update:household_role:transfer-ownership` is the
 * gate that keeps owner transitions (both directions) out of #156's
 * change-role endpoint; an Admin holding it would defeat that separation.
 *
 * Household roles hold the `:household` variant of every event sub-resource
 * grant, bound through the event's household; the event-bound original
 * belongs to the event roles alone, because the household pass never supplies
 * `{{ eventId }}` (#436, #432).
 *
 * A household or event role holds nothing `User` holds. Every signed-in
 * user's ability is built in one pass that includes `User`, so a scoped role's
 * copy of one of its slugs grants nothing. Where the condition names the actor
 * rather than the scope (`read:households`, `read:game_collection`), the copy
 * renders `User`'s clause again for every membership or attendance: one more
 * `OR` term per scope in that resource's ceiling. On households that was half
 * of the per-membership planning cost measured on #417. An anonymous guest's
 * ability is the exception — it carries `AnonymousUser`, not `User` — so an
 * event role given to a guest does not bring back what that role left to
 * `User`, such as `read:game_play_session` and `create:session_player:join`.
 * Which of those a guest's event role needs is #488's to decide.
 *
 * `AnonymousUser` is the one global role that repeats a `User` slug, and does
 * so on purpose. It is not an elevation: an anonymous user — a temporary,
 * account-less guest — is provisioned it INSTEAD of `User`, never beside it,
 * so its list is everything such a user can do rather than an addition to
 * anything (#484). Anyone can open an anonymous session, which is why that list
 * is pinned and why every entry on it must carry a condition, whatever `User`
 * holds.
 *
 * Insertion order is the seed's assignment order.
 */

const HOUSEHOLD_OWNER: readonly PermissionSlug[] = [
  'create:event_game:household',
  'create:event_invite:household',
  'create:event_occurrence:household',
  'create:game_play_session:household',
  'create:household_invite',
  'create:household_role',
  'create:play_record:household',
  'delete:event_game:household',
  'delete:event_occurrence:household',
  'manage:quota:household_member',
  'create:household_member:join',
  'delete:household_member:leave',
  'delete:event',
  'read:quota:household',
  'delete:game_play_session:household',
  'delete:household',
  'manage:attendee_game_list:household',
  'manage:event_attendee:household',
  'manage:household_member',
  // Plugin unit administration (#59 C4): household owners AND admins —
  // deliberately absent from every non-admin household role.
  'manage:plugin:household',
  'read:plugin:household',
  'read:attendee_game_list:household',
  'read:event_availability_vote:household',
  'read:event_game_nomination:household',
  'read:event_game_vote:household',
  'read:event_game:household',
  'read:event_occurrence:household',
  'read:event_policy:household',
  // The Event row itself. Without it an owner updates a household event and
  // manages its attendees but cannot read the event unless attending it.
  'read:event:participant:household',
  'read:household',
  'read:household_member',
  'update:event_game_nomination:resolve:household',
  'update:event_occurrence:cancel:household',
  'update:event_occurrence:confirm:household',
  'update:event_occurrence:decline:household',
  'update:event_occurrence:household',
  'update:event_policy:household',
  'update:event:household',
  'update:game_play_session:household',
  'update:household',
  'update:household_role:transfer-ownership',
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
  [SystemRole.Admin]: [
    // Cross-subject read. The only wildcard a staff role holds, and read-only.
    'read:public_content',

    // Server staff administration: the writes that deliberately ignore the
    // household scope coordinate, so staff can act on a household they are no
    // member of. Transferring ownership is NOT among them — no route performs
    // it for a non-member, and the catalog says so rather than implying
    // otherwise (see the block comment on these slugs).
    'manage:household_member:administer',
    'delete:household:administer',
    'delete:game_play_session:moderate',

    // The games catalogue. Unconditioned, which is what curating an install
    // requires: an imported game belongs to the server, and a user-created one
    // may be private without being beyond moderation. The `createdById`-scoped
    // pair lives on `User` and would add nothing here anyway.
    'update:game',
    'delete:game',

    // PlatformGame
    'create:platform_game',
    'update:platform_game',
    'delete:platform_game',

    // Platform
    'create:platform',
    'update:platform',
    'delete:platform',

    // Game Gateway
    'read:game_gateway',
    'create:game_gateway',
    'update:game_gateway',
    'delete:game_gateway',

    // Events. Only the moderation variant: `delete:event` is scoped
    // `createdById: '{{ user.id }}'` and an event's creator is seeded
    // `EventHost` on it (`event.service.ts`), which carries that slug already.
    'read:event',
    'delete:event:moderate',

    // Media moderation
    'read:media_contribution',
    'update:media_contribution:moderate',

    // Feedback triage
    'read:feedback_report',
    'delete:feedback_report',
    'manage:feedback_report',
    'read:feedback_sink_dispatch',

    // Operations surfaces: server-owned rows with no scope to bind to.
    'read:safe_http_policy',
    'manage:safe_http_policy',
    'manage:plugin',
    'read:plugin',
    'read:audit_log',
    'manage:quota',
    'read:quota',
  ],
  [SystemRole.Moderator]: [
    // Cross-subject read: a moderator triages content in households they are
    // no member of, and this is the grant that lets them see it.
    'read:public_content',

    // audit
    'read:audit_log',

    // event
    'read:event',
    'delete:event:moderate',

    // feedback
    'read:feedback_report',
    'read:feedback_sink_dispatch',

    // game
    'update:game',
    'delete:game_play_session:moderate',

    'read:safe_http_policy',

    // media
    'read:media_contribution',
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
    'delete:game:own',
    'read:game',
    'read:job',
    'update:game:own',

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
  [SystemRole.AnonymousUser]: ['read:game_collection:public'],
  [SystemRole.HouseholdOwner]: HOUSEHOLD_OWNER,
  [SystemRole.HouseholdAdmin]: HOUSEHOLD_OWNER.filter((slug) => !HOUSEHOLD_OWNER_ONLY.includes(slug)),
  [SystemRole.HouseholdMember]: [
    'create:game_play_session:household',
    'create:play_record:household',
    'read:attendee_game_list:household',
    'read:event_attendee:household',
    'read:event_availability_vote:household',
    'read:event_game_nomination:household',
    'read:event_game_vote:household',
    'read:event_game:household',
    'read:household_member',
    'delete:household_member:leave',
    'read:event_occurrence:household',
    'read:event_policy:household',
    'read:event:participant:household',
    'read:household',
  ],
  [SystemRole.HouseholdGuest]: [
    'delete:household_member:leave',
    'read:event:participant:household',
    'read:household',
    'read:household_member',
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
    'update:event_attendee:status:self',
    'update:event_game_nomination:withdraw',
    'update:game_play_session',
  ],
  [SystemRole.EventGuest]: [
    'create:attendee_game_list',
    'create:event_availability_vote',
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
  ],
};

assertRolePermissionCatalog(ROLE_PERMISSION_CATALOG, PERMISSION_CATALOG);
