import { Action, ResourceType, SystemRole } from '../client';
import {
  findTemplateDefects,
  findUnconditionedGlobalGrants,
  findUnconditionedScopedGrants,
  findUnrenderableTemplateGrants,
} from './catalog-guards';
import type { PermissionSlug } from './permission.catalog';
import { PERMISSION_CATALOG } from './permission.catalog';
import { ROLE_PERMISSION_CATALOG } from './role-permission.catalog';
import { KNOWN_TEMPLATE_VARIABLES, RENDER_CONTEXT_VARIABLES, ROLE_SCOPE } from './role.catalog';

/**
 * What the shipped catalog is known to contain, one ledger per guard in
 * `catalog-guards.ts`, pinned exactly in both directions and at EDGE
 * granularity: a role→permission pair a guard finds that is not listed fails
 * (a new one, or an old one reaching a new role), and a listed pair the guard
 * no longer finds fails too (it went away, delete the line). That second
 * direction is what keeps this file honest while #244 burns its ledger down —
 * a list that only grows is where defects go to be forgotten. #432 and #436
 * have already emptied theirs; those ledgers stay so the next instance of
 * either class is named at the guard rather than shipped.
 *
 * **Two of these are defect ledgers and one is an allowlist**, and the
 * difference matters to anyone reading a long list here as a backlog.
 * `UNCONDITIONED_SCOPED_GRANTS` and `INERT_STAFF_GRANTS` describe edges that
 * should not exist and are measured by how close to empty they are.
 * `DECLARED_GLOBAL_STAFF_GRANTS` describes edges that mostly SHOULD exist —
 * install-wide reference data has no scope coordinate to bind to — and is
 * measured by whether every line was written on purpose. It ratchets on
 * additions; emptying it is not a goal (#244).
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
 * The allowlist's entries carry the AUTHORITY, not just the edge. What a
 * reviewer approved when they wrote a line is `action` on `subject` with no
 * conditions; if either changes under a listed slug the approval is stale, and
 * keying on the slug alone would let `update` on `MediaContribution` widen to
 * `manage` on `all` with every ledger still green — the precise escalation
 * `manage:content:moderate` already is.
 */
type DeclaredGrant = readonly [
  slug: PermissionSlug,
  role: SystemRole,
  action: Action,
  subject: ResourceType | 'all',
];

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
  ['create:attendee_game_list', SystemRole.Admin],
  ['delete:attendee_game_list', SystemRole.Admin],
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

/**
 * The DECLARED global staff grants: unconditioned permissions held by a global
 * role other than `User`, so they reach every row of their subject. Unlike the
 * two ledgers above this one is an ALLOWLIST, and it is not expected to empty —
 * most of what it holds is correct, because install-wide reference data
 * (platforms, gateways, quotas, the audit log) has no scope coordinate for a
 * condition to bind to. Do not read a long list here as a backlog (#244).
 *
 * What it buys is the declaration. The ratchet runs both ways as above: an
 * unconditioned global grant the guard finds that is not listed fails as
 * `unlisted`, so a new one cannot arrive without someone writing the line; and
 * a listed grant the guard no longer finds fails as `fixed`, so retiring one
 * means deleting its line. `manage:content:moderate` is why the guard exists —
 * an unconditioned `manage` on `all`, held by `Admin` and `Moderator`, which
 * makes both functionally `Owner` and which neither other guard can see. It is
 * listed here rather than exempted; retiring it is #244's policy half.
 */
const DECLARED_GLOBAL_STAFF_GRANTS: readonly DeclaredGrant[] = [
  // The wildcards, `subject: 'all'`. `manage:all` is the designed one and the
  // reason `Owner` exists. The other two are not designed, they accumulated:
  // `manage:content:moderate` is an unconditioned `manage` on `all`, so
  // `Admin` and `Moderator` are each functionally `Owner`, and no audit of
  // either role's permission list says so because the slug reads like a narrow
  // moderation grant. #244 retires it and keeps `read:public_content`,
  // which is read-only and the substance of a triage role; the read-widening
  // it causes is #364/#365/#419's subject, not this guard's.
  ['manage:all', SystemRole.Owner, Action.manage, 'all'],
  ['manage:content:moderate', SystemRole.Admin, Action.manage, 'all'],
  ['manage:content:moderate', SystemRole.Moderator, Action.manage, 'all'],
  ['read:public_content', SystemRole.Admin, Action.read, 'all'],
  ['read:public_content', SystemRole.Moderator, Action.read, 'all'],

  // Install-wide reference data: platforms, the games catalogue and the
  // gateways games are imported through. There is no household or event these
  // rows belong to, so there is no coordinate a condition could bind them to —
  // unconditioned is the only shape they can take, and curating them is what
  // `Admin` is for.
  ['create:platform', SystemRole.Admin, Action.create, ResourceType.Platform],
  ['update:platform', SystemRole.Admin, Action.update, ResourceType.Platform],
  ['delete:platform', SystemRole.Admin, Action.delete, ResourceType.Platform],
  ['create:platform_game', SystemRole.Admin, Action.create, ResourceType.PlatformGame],
  ['update:platform_game', SystemRole.Admin, Action.update, ResourceType.PlatformGame],
  ['delete:platform_game', SystemRole.Admin, Action.delete, ResourceType.PlatformGame],
  ['create:game_gateway', SystemRole.Admin, Action.create, ResourceType.GameGateway],
  ['read:game_gateway', SystemRole.Admin, Action.read, ResourceType.GameGateway],
  ['update:game_gateway', SystemRole.Admin, Action.update, ResourceType.GameGateway],
  ['delete:game_gateway', SystemRole.Admin, Action.delete, ResourceType.GameGateway],
  ['update:game', SystemRole.Admin, Action.update, ResourceType.Game],
  ['update:game', SystemRole.Moderator, Action.update, ResourceType.Game],
  ['delete:game', SystemRole.Admin, Action.delete, ResourceType.Game],

  // Operations surfaces, install-wide for the same reason: the audit log,
  // operator-set quota caps, the outbound-request policy and the plugin
  // registry are all server-owned rows.
  ['read:audit_log', SystemRole.Admin, Action.read, ResourceType.AuditLog],
  ['read:audit_log', SystemRole.Moderator, Action.read, ResourceType.AuditLog],
  ['read:quota', SystemRole.Admin, Action.read, ResourceType.Quota],
  ['manage:quota', SystemRole.Admin, Action.manage, ResourceType.Quota],
  ['read:safe_http_policy', SystemRole.Admin, Action.read, ResourceType.SafeHttpPolicy],
  ['read:safe_http_policy', SystemRole.Moderator, Action.read, ResourceType.SafeHttpPolicy],
  ['manage:safe_http_policy', SystemRole.Admin, Action.manage, ResourceType.SafeHttpPolicy],
  ['read:plugin', SystemRole.Admin, Action.read, ResourceType.Plugin],
  ['manage:plugin', SystemRole.Admin, Action.manage, ResourceType.Plugin],

  // The moderation queue. Reaching every row is the point of a queue — a
  // moderator who could only see their own household's reports could not
  // moderate. `delete:event:moderate` carries a standing TODO asking for
  // conditions "to validate moderator role and scope"; #244 answers it —
  // the grant is staff-only by assignment and unconditioned on purpose, and
  // this line is where that now says so.
  ['read:feedback_report', SystemRole.Admin, Action.read, ResourceType.FeedbackReport],
  ['read:feedback_report', SystemRole.Moderator, Action.read, ResourceType.FeedbackReport],
  ['delete:feedback_report', SystemRole.Admin, Action.delete, ResourceType.FeedbackReport],
  ['manage:feedback_report', SystemRole.Admin, Action.manage, ResourceType.FeedbackReport],
  ['read:feedback_sink_dispatch', SystemRole.Admin, Action.read, ResourceType.FeedbackSinkDispatch],
  ['read:feedback_sink_dispatch', SystemRole.Moderator, Action.read, ResourceType.FeedbackSinkDispatch],
  ['read:media_contribution', SystemRole.Admin, Action.read, ResourceType.MediaContribution],
  ['read:media_contribution', SystemRole.Moderator, Action.read, ResourceType.MediaContribution],
  ['update:media_contribution:moderate', SystemRole.Admin, Action.update, ResourceType.MediaContribution],
  ['update:media_contribution:moderate', SystemRole.Moderator, Action.update, ResourceType.MediaContribution],
  ['read:event', SystemRole.Admin, Action.read, ResourceType.Event],
  ['read:event', SystemRole.Moderator, Action.read, ResourceType.Event],
  ['delete:event:moderate', SystemRole.Admin, Action.delete, ResourceType.Event],
  ['delete:event:moderate', SystemRole.Moderator, Action.delete, ResourceType.Event],
];

const edge = (slug: string, role: string) => `${slug} via ${role}`;

/**
 * The allowlist's comparable value. The authority is IN the key, not in the
 * detail: a detail string is only rendered for entries that fail as `unlisted`,
 * so an `action` or `subject` that moved under an already-listed slug would
 * never be compared against anything. In the key, widening one shows up as the
 * old line `fixed` and the new one `unlisted` — the loud failure this ledger
 * exists to produce.
 */
const declaredEdge = (slug: string, role: string, action: string, subject: string) =>
  `${edge(slug, role)} (${action} on ${subject})`;

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
  const declaredGlobalGrants = DECLARED_GLOBAL_STAFF_GRANTS.map(([slug, role, action, subject]) =>
    declaredEdge(slug, role, action, subject),
  );

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

  it('has exactly the declared unconditioned grants on global staff roles — an allowlist, not a backlog', () => {
    const found = findUnconditionedGlobalGrants(
      PERMISSION_CATALOG,
      ROLE_PERMISSION_CATALOG,
      ROLE_SCOPE,
      SystemRole.User,
    );

    expect(
      reconcile(
        new Map(
          found.map(({ slug, role, action, subject }) => [
            declaredEdge(slug, role, action, subject),
            '(unconditioned, so it reaches every row of the subject)',
          ]),
        ),
        declaredGlobalGrants,
      ),
    ).toEqual({ unlisted: [], fixed: [] });
  });

  it('lists each known defect once, so a duplicate line cannot stand in for a fix', () => {
    expect(new Set(unconditionedGrants).size).toBe(unconditionedGrants.length);
    expect(new Set(inertGrants).size).toBe(inertGrants.length);
    expect(new Set(declaredGlobalGrants).size).toBe(declaredGlobalGrants.length);
  });
});
