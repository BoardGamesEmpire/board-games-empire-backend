import { ResourceType, SystemRole } from '../client';
import { deriveReadCeilings, type ReadReach } from './catalog-read-ceilings';
import type { PermissionSlug } from './permission.catalog';
import { PERMISSION_CATALOG } from './permission.catalog';
import { ROLE_PERMISSION_CATALOG } from './role-permission.catalog';

/**
 * Every catalog role's read ceiling on every subject, pinned exactly. This is
 * the half of #415's intrinsic-scope table that the catalog decides: which
 * roles the catalog lets read a subject, and how much of it each one reaches.
 * The other half — what each list route SHOULD return — is prose on #365, and
 * it is read against this.
 *
 * How to read an entry (see `ReadReach`):
 *
 * - `'every row'` — no conditions; the role reads the whole table.
 * - `'fixed filter'` — a static filter; every holder reads the same rows.
 * - `'binds …'` — the rows depend on the variables named: `user.id` per
 *   caller, `householdId` per membership, `eventId` per attendance.
 *
 * The wildcards sit under `all` and apply to every subject below it; they are
 * not repeated. A subject mapped to `{}` is one no catalog role reaches except
 * through a wildcard.
 *
 * Each role is shown alone. A caller's ceiling is the union of the roles they
 * hold, and every signed-in user except an anonymous guest holds `User`
 * beneath any household, event or staff role — so a `HouseholdOwner` reads
 * `Game` through `User`, though no `Game` line names them. Direct
 * `UserPermission` rows and plugin grants are runtime data and are not here.
 *
 * A grant added, removed, or moving between those three reaches fails here,
 * and the literal is updated in the same change. That diff is the point: it is
 * where a reviewer sees a list's answer set move. Any line that is not
 * `'binds …'` deserves a second look rather than a mechanical update — a new
 * `'every row'` or `'fixed filter'`, or a `'binds …'` that became either —
 * because each gives every holder of the role the same rows, and on a list
 * whose scope is only its ceiling that is the install-wide widening #365
 * exists to remove. A change inside a clause that keeps its reach is below
 * this pin's resolution; `ReadReach` says which.
 *
 * Typed on `ResourceType`, `SystemRole` and `PermissionSlug`, so a misspelt
 * key is a compile error and a new subject cannot go unpinned.
 */
type PinnedReadCeilings = Readonly<
  Record<
    ResourceType | 'all',
    Readonly<Partial<Record<SystemRole, Readonly<Partial<Record<PermissionSlug, ReadReach>>>>>>
  >
>;

const KNOWN_READ_CEILINGS: PinnedReadCeilings = {
  all: {
    Owner: { 'manage:all': 'every row' },
    Admin: { 'read:public_content': 'every row' },
    Moderator: { 'read:public_content': 'every row' },
  },
  System: {},
  AuditLog: {
    Admin: { 'read:audit_log': 'every row' },
    Moderator: { 'read:audit_log': 'every row' },
  },
  Notification: {},
  SafeHttpPolicy: {
    Admin: { 'read:safe_http_policy': 'every row', 'manage:safe_http_policy': 'every row' },
    Moderator: { 'read:safe_http_policy': 'every row' },
  },
  Media: {},
  MediaObject: {
    User: { 'read:media_object:own': 'binds user.id', 'read:media_object:public': 'fixed filter' },
  },
  MediaContribution: {
    Admin: { 'read:media_contribution': 'every row' },
    Moderator: { 'read:media_contribution': 'every row' },
  },
  WebhookSubscription: {
    User: { 'manage:webhook_subscription:own': 'binds user.id', 'read:webhook_subscription:own': 'binds user.id' },
  },
  Quota: {
    Admin: { 'manage:quota': 'every row', 'read:quota': 'every row' },
    HouseholdOwner: {
      'manage:quota:household_member': 'binds householdId',
      'read:quota:household': 'binds householdId',
    },
    HouseholdAdmin: {
      'manage:quota:household_member': 'binds householdId',
      'read:quota:household': 'binds householdId',
    },
  },
  Job: {
    User: { 'read:job': 'every row' },
  },
  Plugin: {
    Admin: { 'manage:plugin': 'every row', 'read:plugin': 'every row' },
  },
  PluginGrant: {},
  HouseholdPlugin: {
    HouseholdOwner: { 'manage:plugin:household': 'binds householdId', 'read:plugin:household': 'binds householdId' },
    HouseholdAdmin: { 'manage:plugin:household': 'binds householdId', 'read:plugin:household': 'binds householdId' },
  },
  UserPlugin: {},
  PluginLifecycleEvent: {},
  User: {},
  UserProfile: {
    User: { 'read:user:profile': 'every row' },
  },
  UserGameCustomization: {},
  Friendship: {
    User: { 'read:friendships:own': 'binds user.id' },
  },
  FeedbackReport: {
    Admin: { 'read:feedback_report': 'every row', 'manage:feedback_report': 'every row' },
    Moderator: { 'read:feedback_report': 'every row' },
    User: { 'read:feedback_report:own': 'binds user.id' },
  },
  FeedbackSinkDispatch: {
    Admin: { 'read:feedback_sink_dispatch': 'every row' },
    Moderator: { 'read:feedback_sink_dispatch': 'every row' },
  },
  Campaign: {},
  Game: {
    User: { 'read:game': 'binds user.id', 'read:game:public': 'fixed filter' },
  },
  GameCollection: {
    User: {
      'read:game_collection': 'binds user.id',
      'read:game_collection:household': 'binds user.id',
      'read:game_collection:friends': 'binds user.id',
      'read:game_collection:public': 'fixed filter',
    },
    AnonymousUser: { 'read:game_collection:public': 'fixed filter' },
  },
  GameCreationRequest: {},
  GameCustomization: {},
  GameGateway: {
    Admin: { 'read:game_gateway': 'every row' },
  },
  GamePlayResult: {},
  GamePlaySession: {
    User: { 'read:game_play_session': 'every row' },
  },
  GameSharing: {},
  Platform: {
    User: { 'read:platform': 'every row' },
  },
  PlatformGame: {
    User: { 'read:platform_game': 'every row' },
  },
  RuleVariant: {},
  SessionPlayer: {},
  Household: {
    User: { 'read:households:friends': 'binds user.id', 'read:households': 'binds user.id' },
    HouseholdOwner: { 'read:household': 'binds householdId' },
    HouseholdAdmin: { 'read:household': 'binds householdId' },
    HouseholdMember: { 'read:household': 'binds householdId' },
    HouseholdGuest: { 'read:household': 'binds householdId' },
  },
  HouseholdMember: {
    Admin: { 'manage:household_member:administer': 'every row' },
    User: { 'read:household_member:friends': 'binds user.id' },
    HouseholdOwner: {
      'manage:household_member': 'binds householdId, user.id',
      'read:household_member': 'binds householdId',
    },
    HouseholdAdmin: {
      'manage:household_member': 'binds householdId, user.id',
      'read:household_member': 'binds householdId',
    },
    HouseholdMember: { 'read:household_member': 'binds householdId' },
    HouseholdGuest: { 'read:household_member': 'binds householdId' },
  },
  HouseholdRole: {},
  Invite: {},
  Event: {
    Admin: { 'read:event': 'every row' },
    Moderator: { 'read:event': 'every row' },
    User: { 'read:event:friends': 'binds user.id' },
    HouseholdOwner: { 'read:event:participant:household': 'binds householdId' },
    HouseholdAdmin: { 'read:event:participant:household': 'binds householdId' },
    HouseholdMember: { 'read:event:participant:household': 'binds householdId' },
    HouseholdGuest: { 'read:event:participant:household': 'binds householdId' },
    EventHost: { 'read:event:participant': 'binds eventId, user.id' },
    EventCoHost: { 'read:event:participant': 'binds eventId, user.id' },
    EventOrganizer: { 'read:event:participant': 'binds eventId, user.id' },
    EventModerator: { 'read:event:participant': 'binds eventId, user.id' },
    EventParticipant: { 'read:event:participant': 'binds eventId, user.id' },
    EventGuest: { 'read:event:participant': 'binds eventId, user.id' },
    EventSpectator: { 'read:event:participant': 'binds eventId, user.id' },
  },
  EventAttendee: {
    HouseholdOwner: { 'manage:event_attendee:household': 'binds householdId' },
    HouseholdAdmin: { 'manage:event_attendee:household': 'binds householdId' },
    HouseholdMember: { 'read:event_attendee:household': 'binds householdId' },
    EventHost: { 'manage:event_attendee': 'binds eventId', 'read:event_attendee': 'binds eventId' },
    EventCoHost: { 'manage:event_attendee': 'binds eventId', 'read:event_attendee': 'binds eventId' },
    EventOrganizer: { 'manage:event_attendee': 'binds eventId', 'read:event_attendee': 'binds eventId' },
    EventModerator: { 'manage:event_attendee': 'binds eventId', 'read:event_attendee': 'binds eventId' },
    EventParticipant: { 'read:event_attendee': 'binds eventId' },
    EventGuest: { 'read:event_attendee': 'binds eventId' },
    EventSpectator: { 'read:event_attendee': 'binds eventId' },
  },
  EventAttendeeGameList: {
    HouseholdOwner: {
      'manage:attendee_game_list:household': 'binds householdId',
      'read:attendee_game_list:household': 'binds householdId',
    },
    HouseholdAdmin: {
      'manage:attendee_game_list:household': 'binds householdId',
      'read:attendee_game_list:household': 'binds householdId',
    },
    HouseholdMember: { 'read:attendee_game_list:household': 'binds householdId' },
    EventHost: { 'manage:attendee_game_list': 'binds eventId', 'read:attendee_game_list': 'binds eventId' },
    EventCoHost: { 'manage:attendee_game_list': 'binds eventId', 'read:attendee_game_list': 'binds eventId' },
    EventOrganizer: { 'read:attendee_game_list': 'binds eventId' },
    EventModerator: { 'manage:attendee_game_list': 'binds eventId', 'read:attendee_game_list': 'binds eventId' },
    EventParticipant: { 'read:attendee_game_list': 'binds eventId' },
    EventGuest: { 'read:attendee_game_list': 'binds eventId' },
    EventSpectator: { 'read:attendee_game_list': 'binds eventId' },
  },
  EventAvailabilityVote: {
    HouseholdOwner: { 'read:event_availability_vote:household': 'binds householdId' },
    HouseholdAdmin: { 'read:event_availability_vote:household': 'binds householdId' },
    HouseholdMember: { 'read:event_availability_vote:household': 'binds householdId' },
    EventHost: { 'read:event_availability_vote': 'binds eventId' },
    EventCoHost: { 'read:event_availability_vote': 'binds eventId' },
    EventOrganizer: { 'read:event_availability_vote': 'binds eventId' },
    EventModerator: { 'read:event_availability_vote': 'binds eventId' },
    EventParticipant: { 'read:event_availability_vote': 'binds eventId' },
    EventGuest: { 'read:event_availability_vote': 'binds eventId' },
    EventSpectator: { 'read:event_availability_vote': 'binds eventId' },
  },
  EventGame: {
    HouseholdOwner: { 'read:event_game:household': 'binds householdId' },
    HouseholdAdmin: { 'read:event_game:household': 'binds householdId' },
    HouseholdMember: { 'read:event_game:household': 'binds householdId' },
    EventHost: { 'read:event_game': 'binds eventId' },
    EventCoHost: { 'read:event_game': 'binds eventId' },
    EventOrganizer: { 'read:event_game': 'binds eventId' },
    EventModerator: { 'read:event_game': 'binds eventId' },
    EventParticipant: { 'read:event_game': 'binds eventId' },
    EventGuest: { 'read:event_game': 'binds eventId' },
    EventSpectator: { 'read:event_game': 'binds eventId' },
  },
  EventGameNomination: {
    HouseholdOwner: { 'read:event_game_nomination:household': 'binds householdId' },
    HouseholdAdmin: { 'read:event_game_nomination:household': 'binds householdId' },
    HouseholdMember: { 'read:event_game_nomination:household': 'binds householdId' },
    EventHost: { 'read:event_game_nomination': 'binds eventId' },
    EventCoHost: { 'read:event_game_nomination': 'binds eventId' },
    EventOrganizer: { 'read:event_game_nomination': 'binds eventId' },
    EventModerator: { 'read:event_game_nomination': 'binds eventId' },
    EventParticipant: { 'read:event_game_nomination': 'binds eventId' },
    EventGuest: { 'read:event_game_nomination': 'binds eventId' },
    EventSpectator: { 'read:event_game_nomination': 'binds eventId' },
  },
  EventGameVote: {
    HouseholdOwner: { 'read:event_game_vote:household': 'binds householdId' },
    HouseholdAdmin: { 'read:event_game_vote:household': 'binds householdId' },
    HouseholdMember: { 'read:event_game_vote:household': 'binds householdId' },
    EventHost: { 'read:event_game_vote': 'binds eventId' },
    EventCoHost: { 'read:event_game_vote': 'binds eventId' },
    EventOrganizer: { 'read:event_game_vote': 'binds eventId' },
    EventModerator: { 'read:event_game_vote': 'binds eventId' },
    EventParticipant: { 'read:event_game_vote': 'binds eventId' },
    EventGuest: { 'read:event_game_vote': 'binds eventId' },
    EventSpectator: { 'read:event_game_vote': 'binds eventId' },
  },
  EventOccurrence: {
    HouseholdOwner: { 'read:event_occurrence:household': 'binds householdId' },
    HouseholdAdmin: { 'read:event_occurrence:household': 'binds householdId' },
    HouseholdMember: { 'read:event_occurrence:household': 'binds householdId' },
    EventHost: { 'read:event_occurrence': 'binds eventId' },
    EventCoHost: { 'read:event_occurrence': 'binds eventId' },
    EventOrganizer: { 'read:event_occurrence': 'binds eventId' },
    EventModerator: { 'read:event_occurrence': 'binds eventId' },
    EventParticipant: { 'read:event_occurrence': 'binds eventId' },
    EventGuest: { 'read:event_occurrence': 'binds eventId' },
    EventSpectator: { 'read:event_occurrence': 'binds eventId' },
  },
  EventPolicy: {
    HouseholdOwner: { 'read:event_policy:household': 'binds householdId' },
    HouseholdAdmin: { 'read:event_policy:household': 'binds householdId' },
    HouseholdMember: { 'read:event_policy:household': 'binds householdId' },
    EventHost: { 'read:event_policy': 'binds eventId' },
    EventCoHost: { 'read:event_policy': 'binds eventId' },
    EventOrganizer: { 'read:event_policy': 'binds eventId' },
    EventModerator: { 'read:event_policy': 'binds eventId' },
    EventParticipant: { 'read:event_policy': 'binds eventId' },
    EventGuest: { 'read:event_policy': 'binds eventId' },
    EventSpectator: { 'read:event_policy': 'binds eventId' },
  },
};

describe('the shipped catalog', () => {
  it('has exactly the pinned read ceilings, so a list whose answer set moves is a visible diff', () => {
    expect(
      deriveReadCeilings(PERMISSION_CATALOG, ROLE_PERMISSION_CATALOG, ['all', ...Object.values(ResourceType)]),
    ).toEqual(KNOWN_READ_CEILINGS);
  });
});
