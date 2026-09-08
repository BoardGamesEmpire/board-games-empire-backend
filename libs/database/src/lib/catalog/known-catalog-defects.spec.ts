import { SystemRole } from '../client';
import { findTemplateDefects, findUnconditionedScopedGrants, findUnrenderableTemplateGrants } from './catalog-guards';
import type { PermissionSlug } from './permission.catalog';
import { PERMISSION_CATALOG } from './permission.catalog';
import { ROLE_PERMISSION_CATALOG } from './role-permission.catalog';
import { KNOWN_TEMPLATE_VARIABLES, RENDER_CONTEXT_VARIABLES, ROLE_SCOPE } from './role.catalog';

/**
 * The shipped catalog's KNOWN defects, one ledger per guard in
 * `catalog-guards.ts`, pinned exactly in both directions and at EDGE
 * granularity: a role→permission pair a guard finds that is not listed fails
 * (a new defect, or an old one reaching a new role), and a listed pair the
 * guard no longer finds fails too (the fix landed, delete the line). That
 * second direction is what keeps this file honest while #432, #244 and #436
 * burn it down — a ledger that only grows is where defects go to be forgotten.
 *
 * The ledgers are typed on `PermissionSlug` and `SystemRole`, so a misspelt
 * entry is a compile error rather than a permanently "fixed" line.
 */

/**
 * Unconditioned permissions — no template variable, so nothing binds them to
 * the actor or the scope — granted through household- and event-scoped roles
 * and not held by `User`, so every holder has install-wide reach on the
 * subject. Keyed by slug because that is the unit #432 remediates: adding a
 * condition to the permission clears every role listed against it at once.
 * A role gaining or losing the slug changes its line.
 */
const UNCONDITIONED_SCOPED_GRANTS: Readonly<Partial<Record<PermissionSlug, readonly SystemRole[]>>> = {
  // Occurrences
  'read:event_occurrence': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.HouseholdMember,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventOrganizer,
    SystemRole.EventModerator,
    SystemRole.EventParticipant,
    SystemRole.EventGuest,
    SystemRole.EventSpectator,
  ],
  'create:event_occurrence': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventOrganizer,
  ],
  'update:event_occurrence': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventOrganizer,
    SystemRole.EventModerator,
  ],
  'delete:event_occurrence': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
  ],
  'update:event_occurrence:confirm': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
  ],
  'update:event_occurrence:decline': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
  ],
  'update:event_occurrence:cancel': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventModerator,
  ],

  // Availability, nominations, votes
  'read:event_availability_vote': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.HouseholdMember,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventOrganizer,
    SystemRole.EventModerator,
    SystemRole.EventParticipant,
    SystemRole.EventGuest,
    SystemRole.EventSpectator,
  ],
  'read:event_game_nomination': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.HouseholdMember,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventOrganizer,
    SystemRole.EventModerator,
    SystemRole.EventParticipant,
    SystemRole.EventGuest,
    SystemRole.EventSpectator,
  ],
  'create:event_game_nomination': [SystemRole.EventHost, SystemRole.EventCoHost, SystemRole.EventParticipant],
  'update:event_game_nomination:resolve': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventModerator,
  ],
  'update:event_game_nomination:approve': [SystemRole.EventHost, SystemRole.EventCoHost],
  'update:event_game_nomination:reject': [SystemRole.EventHost, SystemRole.EventCoHost],
  'read:event_game_vote': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.HouseholdMember,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventOrganizer,
    SystemRole.EventModerator,
    SystemRole.EventParticipant,
    SystemRole.EventGuest,
    SystemRole.EventSpectator,
  ],

  // Event games and game lists
  'read:event_game': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.HouseholdMember,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventOrganizer,
    SystemRole.EventModerator,
    SystemRole.EventParticipant,
    SystemRole.EventGuest,
    SystemRole.EventSpectator,
  ],
  'create:event_game': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventParticipant,
  ],
  'delete:event_game': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventModerator,
  ],
  'read:attendee_game_list': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.HouseholdMember,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventOrganizer,
    SystemRole.EventModerator,
    SystemRole.EventParticipant,
    SystemRole.EventGuest,
    SystemRole.EventSpectator,
  ],
  'manage:attendee_game_list': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventModerator,
  ],

  // Policy
  'read:event_policy': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.HouseholdMember,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventOrganizer,
    SystemRole.EventModerator,
    SystemRole.EventParticipant,
    SystemRole.EventGuest,
    SystemRole.EventSpectator,
  ],
  'update:event_policy': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
  ],

  // Play
  'create:play_record': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.HouseholdMember,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventParticipant,
  ],
  'create:game_play_session': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.HouseholdMember,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventParticipant,
  ],
  'update:game_play_session': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventParticipant,
  ],
  'delete:game_play_session': [
    SystemRole.HouseholdOwner,
    SystemRole.HouseholdAdmin,
    SystemRole.EventHost,
    SystemRole.EventCoHost,
    SystemRole.EventModerator,
  ],
  'create:session_player:observer:join': [SystemRole.EventSpectator],

  // Media
  'create:media:upload': [SystemRole.EventParticipant],
};

type Grant = readonly [slug: PermissionSlug, role: SystemRole];

/**
 * Global staff roles holding grants templated on `{{ householdId }}` or
 * `{{ eventId }}`: the `roles` pass supplies neither, so server staff cannot
 * act on any household or event they are not personally a member of. The
 * policy fix — explicit unconditional staff variants — is #244.
 */
const INERT_STAFF_GRANTS: readonly Grant[] = [
  ['read:household', SystemRole.Admin],
  ['read:household', SystemRole.Moderator],
  ['update:household', SystemRole.Admin],
  ['delete:household', SystemRole.Admin],
  ['manage:household_member', SystemRole.Admin],
  ['read:household_member', SystemRole.Admin],
  ['delete:household_member:leave', SystemRole.Admin],
  ['update:household_role:transfer-ownership', SystemRole.Admin],
  ['create:household_invite', SystemRole.Admin],
  ['create:household_member:join', SystemRole.Admin],
  ['manage:plugin:household', SystemRole.Admin],
  ['read:plugin:household', SystemRole.Admin],
  ['read:quota:household', SystemRole.Admin],
  ['manage:quota:household_member', SystemRole.Admin],
  ['read:event_attendee', SystemRole.Admin],
  ['update:event_attendee:status', SystemRole.Admin],
  ['read:event:participant', SystemRole.Admin],
  ['update:event', SystemRole.Admin],
  ['update:event', SystemRole.Moderator],
  ['update:event:status:cancel-event', SystemRole.Admin],
  ['update:event:status:archive-event', SystemRole.Admin],
  ['create:event_invite', SystemRole.Admin],
  ['manage:event_attendee', SystemRole.Admin],
];

/**
 * Household roles holding grants templated on `{{ eventId }}`: the
 * `householdMember` pass supplies `householdId`, not `eventId`. Whether these
 * become household-bound variants or go is #436.
 */
const INERT_HOUSEHOLD_EVENT_GRANTS: readonly Grant[] = [
  ['read:event_attendee', SystemRole.HouseholdMember],
  ['read:event:participant', SystemRole.HouseholdMember],
  ['read:event:participant', SystemRole.HouseholdGuest],
  ['update:event', SystemRole.HouseholdOwner],
  ['update:event', SystemRole.HouseholdAdmin],
  ['create:event_invite', SystemRole.HouseholdOwner],
  ['create:event_invite', SystemRole.HouseholdAdmin],
  ['manage:event_attendee', SystemRole.HouseholdOwner],
  ['manage:event_attendee', SystemRole.HouseholdAdmin],
];

const edge = (slug: string, role: string) => `${slug} via ${role}`;

/**
 * Both directions of the ratchet as one comparable value. `unlisted` is what
 * the guard found that nobody has claimed, each entry carrying the guard's
 * detail (which pass, which variable) so the failure names the whole defect;
 * `fixed` is what is claimed but no longer found. Either non-empty fails.
 */
function reconcile(found: ReadonlyMap<string, string>, listed: readonly string[]) {
  return {
    unlisted: [...found]
      .filter(([key]) => !listed.includes(key))
      .map(([key, detail]) => `${key} ${detail}`)
      .sort(),
    fixed: listed.filter((key) => !found.has(key)).sort(),
  };
}

describe('the shipped catalog', () => {
  const unconditionedGrants = Object.entries(UNCONDITIONED_SCOPED_GRANTS).flatMap(([slug, roles]) =>
    (roles ?? []).map((role) => edge(slug, role)),
  );
  const inertGrants = [...INERT_STAFF_GRANTS, ...INERT_HOUSEHOLD_EVENT_GRANTS].map(([slug, role]) => edge(slug, role));

  it('has no template that fails to parse, uses a token the factory refuses, or names a variable no context supplies', () => {
    expect(findTemplateDefects(PERMISSION_CATALOG, KNOWN_TEMPLATE_VARIABLES)).toEqual([]);
  });

  it('has exactly the known unconditioned grants on scoped roles — every one owned by #432', () => {
    const found = findUnconditionedScopedGrants(
      PERMISSION_CATALOG,
      ROLE_PERMISSION_CATALOG,
      ROLE_SCOPE,
      SystemRole.User,
    );

    expect(
      reconcile(
        new Map(found.map(({ slug, role, scope }) => [edge(slug, role), `(${scope} pass, nothing to bind)`])),
        unconditionedGrants,
      ),
    ).toEqual({ unlisted: [], fixed: [] });
  });

  it('has exactly the known grants no pass can render — every one owned by #244 or #436', () => {
    const found = findUnrenderableTemplateGrants(
      PERMISSION_CATALOG,
      ROLE_PERMISSION_CATALOG,
      ROLE_SCOPE,
      RENDER_CONTEXT_VARIABLES,
    );

    expect(
      reconcile(
        new Map(
          found.map(({ slug, role, variables }) => [edge(slug, role), `(never renders ${variables.join(', ')})`]),
        ),
        inertGrants,
      ),
    ).toEqual({ unlisted: [], fixed: [] });
  });

  it('lists each known defect once, so a duplicate line cannot stand in for a fix', () => {
    expect(new Set(unconditionedGrants).size).toBe(unconditionedGrants.length);
    expect(new Set(inertGrants).size).toBe(inertGrants.length);
  });
});
