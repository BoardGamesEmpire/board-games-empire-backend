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
 * second direction is what keeps this file honest while #244 burns it down —
 * a ledger that only grows is where defects go to be forgotten. #432 and #436
 * have already emptied theirs; those ledgers stay so the next instance of
 * either class is named at the guard rather than shipped.
 *
 * The ledgers are typed on `PermissionSlug` and `SystemRole`, so a misspelt
 * entry is a compile error rather than a permanently "fixed" line.
 */

/**
 * Unconditioned permissions — no template variable, so nothing binds them to
 * the actor or the scope — granted through household- and event-scoped roles
 * and not held by `User`, so every holder has install-wide reach on the
 * subject. Keyed by slug because that is the unit a fix lands on: adding a
 * condition to the permission clears every role listed against it at once.
 * Emptied by #432, which bound all 27 to `{{ eventId }}` and moved their
 * household holders to `:household` variants. A new entry here is a new
 * defect, not a backlog.
 */
const UNCONDITIONED_SCOPED_GRANTS: Readonly<Partial<Record<PermissionSlug, readonly SystemRole[]>>> = {};

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

  // The event sub-resource grants #432 bound to `{{ eventId }}` reach Admin
  // through the same blanket derivation — and `delete:game_play_session`
  // reaches Moderator by name — where the `roles` pass renders nothing.
  ['read:event_occurrence', SystemRole.Admin],
  ['create:event_occurrence', SystemRole.Admin],
  ['update:event_occurrence', SystemRole.Admin],
  ['delete:event_occurrence', SystemRole.Admin],
  ['update:event_occurrence:confirm', SystemRole.Admin],
  ['update:event_occurrence:decline', SystemRole.Admin],
  ['update:event_occurrence:cancel', SystemRole.Admin],
  ['read:event_availability_vote', SystemRole.Admin],
  ['read:event_game_nomination', SystemRole.Admin],
  ['create:event_game_nomination', SystemRole.Admin],
  ['update:event_game_nomination:resolve', SystemRole.Admin],
  ['update:event_game_nomination:approve', SystemRole.Admin],
  ['update:event_game_nomination:reject', SystemRole.Admin],
  ['read:event_game_vote', SystemRole.Admin],
  ['read:event_game', SystemRole.Admin],
  ['create:event_game', SystemRole.Admin],
  ['delete:event_game', SystemRole.Admin],
  ['read:attendee_game_list', SystemRole.Admin],
  ['manage:attendee_game_list', SystemRole.Admin],
  ['read:event_policy', SystemRole.Admin],
  ['update:event_policy', SystemRole.Admin],
  ['create:play_record', SystemRole.Admin],
  ['create:game_play_session', SystemRole.Admin],
  ['update:game_play_session', SystemRole.Admin],
  ['delete:game_play_session', SystemRole.Admin],
  ['delete:game_play_session', SystemRole.Moderator],
  ['create:session_player:observer:join', SystemRole.Admin],
  ['create:media:upload', SystemRole.Admin],

  // The `:household` variants (#436, #432) reach Admin the same way, and
  // `{{ householdId }}` renders no better there.
  ['read:event_attendee:household', SystemRole.Admin],
  ['read:event:participant:household', SystemRole.Admin],
  ['update:event:household', SystemRole.Admin],
  ['create:event_invite:household', SystemRole.Admin],
  ['manage:event_attendee:household', SystemRole.Admin],
  ['read:event_occurrence:household', SystemRole.Admin],
  ['create:event_occurrence:household', SystemRole.Admin],
  ['update:event_occurrence:household', SystemRole.Admin],
  ['delete:event_occurrence:household', SystemRole.Admin],
  ['update:event_occurrence:confirm:household', SystemRole.Admin],
  ['update:event_occurrence:decline:household', SystemRole.Admin],
  ['update:event_occurrence:cancel:household', SystemRole.Admin],
  ['read:event_availability_vote:household', SystemRole.Admin],
  ['read:event_game_nomination:household', SystemRole.Admin],
  ['update:event_game_nomination:resolve:household', SystemRole.Admin],
  ['read:event_game_vote:household', SystemRole.Admin],
  ['read:event_game:household', SystemRole.Admin],
  ['create:event_game:household', SystemRole.Admin],
  ['delete:event_game:household', SystemRole.Admin],
  ['read:attendee_game_list:household', SystemRole.Admin],
  ['manage:attendee_game_list:household', SystemRole.Admin],
  ['read:event_policy:household', SystemRole.Admin],
  ['update:event_policy:household', SystemRole.Admin],
  ['create:play_record:household', SystemRole.Admin],
  ['create:game_play_session:household', SystemRole.Admin],
  ['update:game_play_session:household', SystemRole.Admin],
  ['delete:game_play_session:household', SystemRole.Admin],
];

/**
 * Household roles holding grants templated on `{{ eventId }}`: the
 * `householdMember` pass supplies `householdId`, not `eventId`. Emptied by
 * #436, which moved every such grant to a `:household` variant bound through
 * the event's household. A new line here is a new defect, not a backlog.
 */
const INERT_HOUSEHOLD_EVENT_GRANTS: readonly Grant[] = [];

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

  it('has no unconditioned grant on a scoped role — #432 emptied this ledger', () => {
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

  it('has exactly the known grants no pass can render — every one owned by #244', () => {
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
