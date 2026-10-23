import {
  Action,
  MemberInvitePolicy,
  MemberSharePolicy,
  QuotaScope,
  ResourceType,
  ROLE_PERMISSION_CATALOG,
  SystemRole,
} from '@bge/database';
import { AbilityFactory, type AppAbility, type RoleWithPermissions } from '@bge/permissions';
import { catalogPermission } from '@bge/testing';
import { subject } from '@casl/ability';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What each household role can do, as `README.md` in this lib states it (#168).
 * Every cell is asked of the role's real ability, rendered from the shipped
 * catalog the way a signed-in member's is: `User` through the roles pass, plus
 * the household role through the household pass, for household `hh-1`. Each
 * row asks about an instance shaped like the one its route asks about, so a
 * catalog change that moves a cell fails here, and the README is compared with
 * this table so the two can't drift apart.
 */

type Cell = 'Yes' | 'No' | 'For approval';

type HouseholdRoleName =
  | typeof SystemRole.HouseholdOwner
  | typeof SystemRole.HouseholdAdmin
  | typeof SystemRole.HouseholdMember
  | typeof SystemRole.HouseholdGuest;

interface TableRow {
  /** The row's text in the README, exactly. */
  readonly action: string;
  readonly grantedBy: 'Household role' | 'User';
  readonly cells: Readonly<Record<HouseholdRoleName, Cell>>;
  /** Asks the actor's ability, holding `actor` in `hh-1`, the question the route asks. */
  readonly ask: (ability: AppAbility, actor: HouseholdRoleName) => string;
}

const HOUSEHOLD_ROLES: readonly HouseholdRoleName[] = [
  SystemRole.HouseholdOwner,
  SystemRole.HouseholdAdmin,
  SystemRole.HouseholdMember,
  SystemRole.HouseholdGuest,
];

const ACTOR = 'user-1';
const OTHER = 'user-2';
const HOUSEHOLD = 'hh-1';
const EVENT = 'ev-1';

const yesNo = (allowed: boolean): Cell => (allowed ? 'Yes' : 'No');

/** One answer for a row that asks about two cases the README groups, or both answers when they differ. */
const same = (...answers: string[]): string => (new Set(answers).size === 1 ? answers[0] : answers.join(' / '));

/** The household's roster as the instance carries it: the acting user, holding `actor`. */
const roster = (actor: HouseholdRoleName) => [{ userId: ACTOR, role: { role: { name: actor } } }];

/** A membership row of `hh-1`, holding `target`, as the role change and removal ask about it. */
const memberRow = (actor: HouseholdRoleName, target: SystemRole, userId = OTHER) =>
  subject(ResourceType.HouseholdMember, {
    householdId: HOUSEHOLD,
    userId,
    role: { role: { name: target } },
    household: { members: roster(actor) },
  });

/** Whether the actor may manage another member holding `target`: a role change or a removal. */
const managesA = (ability: AppAbility, actor: HouseholdRoleName, target: SystemRole) =>
  ability.can(Action.manage, memberRow(actor, target));

/**
 * How an invite offering `offers` opens under `policy`, asked in the order the
 * create asks: directly, then awaiting approval.
 */
const inviteOpens = (
  ability: AppAbility,
  actor: HouseholdRoleName,
  offers: SystemRole,
  policy: MemberInvitePolicy,
): Cell => {
  const invite = (needsApproval: boolean) =>
    subject(ResourceType.Invite, {
      householdId: HOUSEHOLD,
      needsApproval,
      role: { name: offers },
      household: { settings: { memberInvitePolicy: policy }, members: roster(actor) },
    });

  if (ability.can(Action.create, invite(false))) {
    return 'Yes';
  }

  return ability.can(Action.create, invite(true)) ? 'For approval' : 'No';
};

/** An open invite of `hh-1` offering `offers`, as a revoke or an approval asks about it. */
const openInvite = (actor: HouseholdRoleName, offers: SystemRole) =>
  subject(ResourceType.Invite, {
    id: 'invite-1',
    householdId: HOUSEHOLD,
    role: { name: offers },
    household: { members: roster(actor) },
  });

/**
 * How the actor's share of a live game they created into `hh-1` opens under
 * `policy`, asked in the order the create asks (#810): in effect at once, then
 * waiting for approval.
 */
const shareOpens = (ability: AppAbility, actor: HouseholdRoleName, policy: MemberSharePolicy): Cell => {
  const share = (approvedAt: Date | null) =>
    subject(ResourceType.GameShare, {
      householdId: HOUSEHOLD,
      approvedAt,
      game: { deletedAt: null, createdById: ACTOR },
      household: { settings: { memberSharePolicy: policy }, members: roster(actor) },
    });

  if (ability.can(Action.create, share(new Date()))) {
    return 'Yes';
  }

  return ability.can(Action.create, share(null)) ? 'For approval' : 'No';
};

const sharesAs = (policy: MemberSharePolicy) => (ability: AppAbility, actor: HouseholdRoleName) =>
  shareOpens(ability, actor, policy);

/**
 * A share into `hh-1` that another member made of a game they created, as
 * listing the household's shares, approving one and removing one ask about
 * it. Another member's, because `User` lets the actor read and remove their
 * own shares in any household, and these rows ask what the household role
 * grants (#810).
 */
const othersShare = (actor: HouseholdRoleName, state: { approvedAt?: Date | null } = {}) =>
  subject(ResourceType.GameShare, {
    id: 'share-1',
    householdId: HOUSEHOLD,
    sharedById: OTHER,
    game: { deletedAt: null, createdById: OTHER },
    household: { members: roster(actor) },
    ...state,
  });

/** One of `hh-1`'s events, created by the actor, who holds no event role on it. */
const householdEvent = () => subject(ResourceType.Event, { id: EVENT, householdId: HOUSEHOLD, createdById: ACTOR });
/** A row belonging to one of `hh-1`'s events, such as an occurrence or an attendee. */
const ofHouseholdEvent = (type: ResourceType) => subject(type, { eventId: EVENT, event: { householdId: HOUSEHOLD } });
/** One of `hh-1`'s plays. */
const householdPlay = () => subject(ResourceType.GamePlaySession, { id: 'play-1', householdId: HOUSEHOLD });

const invitesAs = (policy: MemberInvitePolicy) => (ability: AppAbility, actor: HouseholdRoleName) =>
  same(
    inviteOpens(ability, actor, SystemRole.HouseholdMember, policy),
    inviteOpens(ability, actor, SystemRole.HouseholdGuest, policy),
  );

const HOUSEHOLD_ROLE_TABLE: readonly TableRow[] = [
  {
    action: 'See the household',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'Yes', HouseholdGuest: 'Yes' },
    ask: (ability, actor) =>
      yesNo(ability.can(Action.read, subject(ResourceType.Household, { id: HOUSEHOLD, members: roster(actor) }))),
  },
  {
    action: 'Edit the household and its settings',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability, actor) =>
      yesNo(ability.can(Action.update, subject(ResourceType.Household, { id: HOUSEHOLD, members: roster(actor) }))),
  },
  {
    action: 'Delete the household',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'No', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability, actor) =>
      yesNo(ability.can(Action.delete, subject(ResourceType.Household, { id: HOUSEHOLD, members: roster(actor) }))),
  },
  {
    action: 'See the roster',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'Yes', HouseholdGuest: 'Yes' },
    ask: (ability, actor) => yesNo(ability.can(Action.read, memberRow(actor, SystemRole.HouseholdMember))),
  },
  {
    action: 'Change the household role of someone with the member or guest role',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    // The change asks about the member as they stand and as it leaves them.
    ask: (ability, actor) =>
      same(
        yesNo(managesA(ability, actor, SystemRole.HouseholdMember)),
        yesNo(managesA(ability, actor, SystemRole.HouseholdGuest)),
      ),
  },
  {
    action: "Make someone a household admin, or change a household admin's role",
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'No', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability, actor) => yesNo(managesA(ability, actor, SystemRole.HouseholdAdmin)),
  },
  {
    action: 'Remove someone with the member or guest role',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability, actor) =>
      same(
        yesNo(managesA(ability, actor, SystemRole.HouseholdMember)),
        yesNo(managesA(ability, actor, SystemRole.HouseholdGuest)),
      ),
  },
  {
    action: 'Remove a household admin',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'No', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability, actor) => yesNo(managesA(ability, actor, SystemRole.HouseholdAdmin)),
  },
  {
    action: 'Remove another household owner, unless they are the last',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'No', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability, actor) => yesNo(managesA(ability, actor, SystemRole.HouseholdOwner)),
  },
  {
    action: 'Transfer ownership',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'No', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability, actor) =>
      yesNo(
        ability.can(
          Action.update,
          subject(ResourceType.HouseholdRole, {
            householdMember: { household: { id: HOUSEHOLD, members: roster(actor) } },
          }),
        ),
      ),
  },
  {
    action: 'Leave the household',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'Yes', HouseholdGuest: 'Yes' },
    ask: (ability, actor) => yesNo(ability.can(Action.delete, memberRow(actor, actor, ACTOR))),
  },
  {
    action: "List the household's invites",
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability, actor) => yesNo(ability.can(Action.read, openInvite(actor, SystemRole.HouseholdMember))),
  },
  {
    action: 'Invite with the member or guest role, when the member invite policy is Direct',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'Yes', HouseholdGuest: 'No' },
    ask: invitesAs(MemberInvitePolicy.Direct),
  },
  {
    action: 'Invite with the member or guest role, when the member invite policy is NeedsApproval',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'For approval', HouseholdGuest: 'No' },
    ask: invitesAs(MemberInvitePolicy.NeedsApproval),
  },
  {
    action: 'Invite with the member or guest role, when the member invite policy is Off',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: invitesAs(MemberInvitePolicy.Off),
  },
  {
    action: 'Invite with the household admin role',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'No', HouseholdMember: 'No', HouseholdGuest: 'No' },
    // Under the policy most open to members, and still refused to them.
    ask: (ability, actor) => inviteOpens(ability, actor, SystemRole.HouseholdAdmin, MemberInvitePolicy.Direct),
  },
  {
    action: 'Approve an invite sent for approval',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability, actor) =>
      same(
        yesNo(ability.can(Action.update, openInvite(actor, SystemRole.HouseholdMember), 'approvedById')),
        yesNo(ability.can(Action.update, openInvite(actor, SystemRole.HouseholdGuest), 'approvedById')),
      ),
  },
  {
    action: 'Revoke an invite offering the member or guest role',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability, actor) =>
      same(
        yesNo(ability.can(Action.update, openInvite(actor, SystemRole.HouseholdMember), 'status')),
        yesNo(ability.can(Action.update, openInvite(actor, SystemRole.HouseholdGuest), 'status')),
      ),
  },
  {
    action: 'Revoke an invite offering the household admin role',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'No', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability, actor) => yesNo(ability.can(Action.update, openInvite(actor, SystemRole.HouseholdAdmin), 'status')),
  },
  {
    action: 'Share a game they created with the household, when the member share policy is Direct',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'Yes', HouseholdGuest: 'No' },
    ask: sharesAs(MemberSharePolicy.Direct),
  },
  {
    action: 'Share a game they created with the household, when the member share policy is NeedsApproval',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'For approval', HouseholdGuest: 'No' },
    ask: sharesAs(MemberSharePolicy.NeedsApproval),
  },
  {
    action: 'Share a game they created with the household, when the member share policy is Off',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: sharesAs(MemberSharePolicy.Off),
  },
  {
    action: "See the household's game shares",
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability, actor) => yesNo(ability.can(Action.read, othersShare(actor))),
  },
  {
    action: 'Approve a game share sent for approval',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability, actor) => yesNo(ability.can(Action.update, othersShare(actor, { approvedAt: null }), 'approvedAt')),
  },
  {
    action: 'Remove a game share from the household',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability, actor) => yesNo(ability.can(Action.delete, othersShare(actor))),
  },
  {
    action: 'Create a household event',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'Yes', HouseholdGuest: 'No' },
    ask: (ability) => yesNo(ability.can(Action.create, subject(ResourceType.Event, { householdId: HOUSEHOLD }))),
  },
  {
    action: 'See household events, their occurrences and their event policies',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'Yes', HouseholdGuest: 'Yes' },
    ask: (ability) =>
      same(
        yesNo(ability.can(Action.read, householdEvent())),
        yesNo(ability.can(Action.read, ofHouseholdEvent(ResourceType.EventOccurrence))),
        yesNo(ability.can(Action.read, ofHouseholdEvent(ResourceType.EventPolicy))),
      ),
  },
  {
    action: 'See the attendees of household events',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'Yes', HouseholdGuest: 'No' },
    ask: (ability) => yesNo(ability.can(Action.read, ofHouseholdEvent(ResourceType.EventAttendee))),
  },
  {
    action: 'Edit any household event',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability) => yesNo(ability.can(Action.update, householdEvent())),
  },
  {
    action: 'Cancel an occurrence of any household event',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability) => yesNo(ability.can(Action.update, ofHouseholdEvent(ResourceType.EventOccurrence), 'status')),
  },
  {
    action: "Delete an occurrence of a household event they don't host",
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'No', HouseholdAdmin: 'No', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability) => yesNo(ability.can(Action.delete, ofHouseholdEvent(ResourceType.EventOccurrence))),
  },
  {
    action: "Delete a household event they don't host",
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'No', HouseholdAdmin: 'No', HouseholdMember: 'No', HouseholdGuest: 'No' },
    // Created by the actor, which no longer decides (#567).
    ask: (ability) => yesNo(ability.can(Action.delete, householdEvent())),
  },
  {
    action: 'Record a household play',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'Yes', HouseholdGuest: 'No' },
    ask: (ability) =>
      yesNo(ability.can(Action.create, subject(ResourceType.GamePlaySession, { householdId: HOUSEHOLD }))),
  },
  {
    action: 'Edit or delete a household play',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability) =>
      same(yesNo(ability.can(Action.update, householdPlay())), yesNo(ability.can(Action.delete, householdPlay()))),
  },
  {
    action: 'Record results for a household play',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'Yes', HouseholdGuest: 'No' },
    ask: (ability) =>
      yesNo(
        ability.can(
          Action.create,
          subject(ResourceType.GamePlayResult, { gamePlaySession: { householdId: HOUSEHOLD } }),
        ),
      ),
  },
  {
    action: "Manage the household's plugins",
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability) =>
      yesNo(ability.can(Action.manage, subject(ResourceType.HouseholdPlugin, { householdId: HOUSEHOLD }))),
  },
  {
    action: "See the household's quotas",
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability) => yesNo(ability.can(Action.read, subject(ResourceType.Quota, { householdId: HOUSEHOLD }))),
  },
  {
    action: 'Set quotas for each membership',
    grantedBy: 'Household role',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'No', HouseholdGuest: 'No' },
    ask: (ability) =>
      yesNo(
        ability.can(
          Action.manage,
          subject(ResourceType.Quota, { scope: QuotaScope.HouseholdMember, householdId: HOUSEHOLD }),
        ),
      ),
  },
  {
    action: "See the household's game pool",
    grantedBy: 'User',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'Yes', HouseholdGuest: 'Yes' },
    // Another member's entry, in a household the actor belongs to.
    ask: (ability) =>
      yesNo(
        ability.can(
          Action.read,
          subject(ResourceType.GameCollection, {
            userId: OTHER,
            deletedAt: null,
            user: {
              householdMember: [{ showAllGames: true, household: { deletedAt: null, members: [{ userId: ACTOR }] } }],
            },
            excludedFromHouseholds: [],
          }),
        ),
      ),
  },
  {
    action: 'Join a play as a player',
    grantedBy: 'User',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'Yes', HouseholdGuest: 'Yes' },
    ask: (ability) => yesNo(ability.can(Action.create, subject(ResourceType.SessionPlayer, { userId: ACTOR }))),
  },
  {
    action: 'Create and edit house rules',
    grantedBy: 'User',
    cells: { HouseholdOwner: 'Yes', HouseholdAdmin: 'Yes', HouseholdMember: 'Yes', HouseholdGuest: 'Yes' },
    ask: (ability) =>
      same(
        yesNo(ability.can(Action.create, subject(ResourceType.RuleVariant, { createdById: ACTOR }))),
        yesNo(ability.can(Action.update, subject(ResourceType.RuleVariant, { createdById: ACTOR }))),
      ),
  },
];

const README = join(__dirname, '../../README.md');
const TABLE_START = '<!-- household-role-table:start -->';
const TABLE_END = '<!-- household-role-table:end -->';

describe('what each household role can do (#168)', () => {
  let factory: AbilityFactory;

  beforeEach(() => {
    factory = new AbilityFactory();
  });

  /** `User`, plus `roleName` held in `hh-1`; `User` alone when there is none. */
  const abilityFor = (roleName?: HouseholdRoleName): AppAbility =>
    factory.createForUser({
      id: ACTOR,
      roles: [shippedRole(SystemRole.User)],
      householdMember: roleName === undefined ? [] : [{ householdId: HOUSEHOLD, role: shippedRole(roleName) }],
      eventsAttended: [],
      permissions: [],
    });

  it.each(HOUSEHOLD_ROLE_TABLE.flatMap((row) => HOUSEHOLD_ROLES.map((role) => [row.action, role, row] as const)))(
    '%s: %s',
    (_action, role, row) => {
      expect(row.ask(abilityFor(role), role)).toBe(row.cells[role]);
    },
  );

  it.each(HOUSEHOLD_ROLE_TABLE.filter((row) => row.grantedBy === 'User').map((row) => [row.action, row] as const))(
    'grants "%s" through User, which no household role can take away',
    (_action, row) => {
      // Asked of a user holding no household role at all: the roster still
      // names them, as a household's own read would, but no household grant
      // is rendered.
      expect(row.ask(abilityFor(), SystemRole.HouseholdGuest)).toBe('Yes');
    },
  );
});

describe('the README table (#168)', () => {
  it('matches the table the abilities are checked against', () => {
    const readme = readFileSync(README, 'utf8');
    const start = readme.indexOf(TABLE_START);
    const end = readme.indexOf(TABLE_END);

    if (start === -1 || end === -1 || end < start) {
      throw new Error(`${README} has no ${TABLE_START} … ${TABLE_END} block`);
    }

    const [header, separator, ...rows] = readme
      .slice(start + TABLE_START.length, end)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('|'))
      .map((line) =>
        line
          .slice(1, -1)
          .split('|')
          .map((cell) => cell.trim()),
      );

    // The header says which column is which role, so a swapped column would
    // misstate every cell under it.
    expect(header).toEqual([
      'Action',
      'Household owner',
      'Household admin',
      'Member role',
      'Household guest',
      'Granted by',
    ]);
    expect(separator.every((cell) => /^:?-+:?$/.test(cell))).toBe(true);
    expect(rows).toEqual(
      HOUSEHOLD_ROLE_TABLE.map((row) => [
        row.action,
        row.cells.HouseholdOwner,
        row.cells.HouseholdAdmin,
        row.cells.HouseholdMember,
        row.cells.HouseholdGuest,
        row.grantedBy,
      ]),
    );
  });
});

/** A role holding `roleName`'s shipped catalog list, as the seed assigns it. */
function shippedRole(roleName: SystemRole): RoleWithPermissions {
  return {
    role: {
      name: roleName,
      permissions: ROLE_PERMISSION_CATALOG[roleName].map((slug) => ({ permission: catalogPermission(slug) })),
    },
  };
}
