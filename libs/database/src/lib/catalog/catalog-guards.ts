import * as Mustache from 'mustache';
import { hasBoundingConditions } from '../utils/permission-conditions';
import type { PermissionSeedDefinition, RoleScope } from './seed-definitions';

/**
 * Guards over the role↔permission EDGE, which is where the catalog's two
 * silent failure modes live. Neither a permission nor a role assignment is
 * wrong on its own; the pairing is (#234):
 *
 * - **Fail-open.** A permission whose conditions carry no template variable
 *   binds to nothing about the actor: the scope coordinate its pass supplied
 *   has nowhere to land, and `applyRule` emits a `can(action, subject)` that
 *   reaches every row — or, for a static filter like `{ visibility: 'Public' }`,
 *   every matching row install-wide. Granted through a household- or
 *   event-scoped role, that is an install-wide grant wearing a scoped role's
 *   name (#432).
 * - **Fail-closed.** A condition templated on `{{ householdId }}` or
 *   `{{ eventId }}` is rendered by a pass that never supplies it. Mustache
 *   renders the missing variable as `''`, the clause matches no row, and the
 *   grant is inert while every audit of `role_permissions` says it exists
 *   (#244, #436).
 *
 * A third guard sits under both: a template must parse, use only the token
 * types the factory renders, and name only variables SOME context supplies.
 * Its rules mirror `AbilityFactory.assertTemplateWithinContext`, so the
 * catalog is held to the standard the plugin path enforces at runtime.
 *
 * These are specs, not module-scope assertions like `catalog-integrity.ts`:
 * both defect classes have live instances that are being burned down issue by
 * issue, and a throw at import would turn each of them into a boot failure.
 * The known instances are pinned, exactly, in `known-catalog-defects.spec.ts`.
 *
 * Every function takes the catalogs AND the maps it checks against as
 * arguments, nothing defaulted — same convention as the integrity assertions —
 * so fixtures exercise the negative cases and the shipped catalogs go through
 * the same code path. The shipped maps are `ROLE_SCOPE`,
 * `RENDER_CONTEXT_VARIABLES` and `KNOWN_TEMPLATE_VARIABLES` in
 * `role.catalog.ts`.
 *
 * The guards classify a role by that scope map — the pass its name is meant
 * to arrive through. That a household role is only ever assigned through a
 * `household_members` row and never a `user_roles` row is a runtime invariant
 * (#429), not something a catalog guard can see.
 */

/**
 * Why a conditions template cannot be trusted to render, in the factory's own
 * vocabulary: it does not parse, or it uses a token type — partial (`>`),
 * comment (`!`), delimiter change (`=`) — that the factory refuses rather than
 * renders to `''`.
 */
export type TemplateProblem =
  | { kind: 'malformed-template'; message: string }
  | { kind: 'unsupported-token-type'; tokenType: string };

export interface ParsedTemplate {
  /** The variables the template interpolates or sections on, once each, in order of first use. */
  variables: readonly string[];
  /** Empty when the template parses and uses only the token types the factory renders. */
  problems: readonly TemplateProblem[];
}

/** A scoped role holding a permission whose conditions bind to nothing about the actor. */
export interface UnconditionedScopedGrant {
  slug: string;
  role: string;
  scope: RoleScope;
}

/** A role→permission edge whose pass never supplies a variable the conditions need. */
export interface UnrenderableTemplateGrant {
  slug: string;
  role: string;
  scope: RoleScope;
  /** The referenced variables the role's pass does not supply. */
  variables: readonly string[];
}

/** A permission whose template no context could render as written. */
export type TemplateDefect = { slug: string } & (TemplateProblem | { kind: 'unknown-variable'; variable: string });

/**
 * What a conditions object asks of its render context. Parsed with Mustache
 * itself so this agrees with the renderer on what a variable IS:
 * interpolations (`name`, `&`) and section openers (`#`, `^`) name one, and a
 * section's body is walked in turn. Static conditions, and absent ones,
 * reference nothing. A template that does not parse, or uses a token type the
 * factory rejects, comes back as a problem rather than an exception, so a
 * guard can report it under its slug and go on to the next entry.
 */
export function parseTemplate(conditions: unknown): ParsedTemplate {
  if (!hasBoundingConditions(conditions)) {
    return { variables: [], problems: [] };
  }

  let tokens: unknown[];
  try {
    tokens = Mustache.parse(JSON.stringify(conditions));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { variables: [], problems: [{ kind: 'malformed-template', message }] };
  }

  const variables = new Set<string>();
  const problems: TemplateProblem[] = [];
  // Mustache token tuples: [type, name, start, end, subTokens?]. A whitelist,
  // like the factory's: 'text' carries no variable; anything not listed is a
  // problem, because `name` is then a partial name or comment text, not a path.
  const walk = (tokens: unknown[]): void => {
    for (const [type, name, , , subTokens] of tokens as [string, string, number, number, unknown[]?][]) {
      if (type === 'text') {
        continue;
      }

      if (type === 'name' || type === '&' || type === '#' || type === '^') {
        variables.add(name);
        if ((type === '#' || type === '^') && Array.isArray(subTokens)) {
          walk(subTokens);
        }
        continue;
      }

      problems.push({ kind: 'unsupported-token-type', tokenType: type });
    }
  };

  walk(tokens);

  return { variables: [...variables], problems };
}

/**
 * The fail-open guard. An edge fails when the permission is unconditioned —
 * no template variable, so nothing binds it to the actor or the scope — the
 * holding role is SCOPED, and the everyone role does not hold it. All three
 * clauses are load-bearing: without the first, every scoped grant is flagged;
 * without the second, `read:audit_log` is flagged though only global roles
 * hold it; without the third, `read:game_play_session` is flagged though plain
 * `User` holds it, which is the declaration that global reach is intended.
 * Intent is derived from that grant rather than from a marker on the
 * permission, because the everyone role is by construction available to
 * everyone (#234).
 *
 * A template with problems is skipped here: whether it binds anything cannot
 * be judged until `findTemplateDefects` is clean.
 */
export function findUnconditionedScopedGrants(
  catalog: readonly PermissionSeedDefinition[],
  rolePermissions: Readonly<Record<string, readonly string[]>>,
  roleScope: Readonly<Record<string, RoleScope>>,
  everyoneRole: string,
): UnconditionedScopedGrant[] {
  const holders = holdersBySlug(rolePermissions, roleScope);
  const findings: UnconditionedScopedGrant[] = [];

  for (const { slug, conditions } of catalog) {
    const { variables, problems } = parseTemplate(conditions);
    if (variables.length > 0 || problems.length > 0) {
      continue;
    }

    const roles = holders.get(slug) ?? [];
    if (roles.some(({ role }) => role === everyoneRole)) {
      continue;
    }

    for (const { role, scope } of roles) {
      if (scope !== 'global') {
        findings.push({ slug, role, scope });
      }
    }
  }

  return findings;
}

/**
 * The fail-closed guard: the join of what each permission's conditions
 * reference with what the pass rendering each holding role supplies. One
 * finding per edge, listing the variables that would render to `''`. A
 * template with problems is skipped for the same reason as above.
 */
export function findUnrenderableTemplateGrants(
  catalog: readonly PermissionSeedDefinition[],
  rolePermissions: Readonly<Record<string, readonly string[]>>,
  roleScope: Readonly<Record<string, RoleScope>>,
  contextVariables: Readonly<Record<RoleScope, readonly string[]>>,
): UnrenderableTemplateGrant[] {
  const holders = holdersBySlug(rolePermissions, roleScope);
  const findings: UnrenderableTemplateGrant[] = [];

  for (const { slug, conditions } of catalog) {
    const { variables: referenced, problems } = parseTemplate(conditions);
    if (referenced.length === 0 || problems.length > 0) {
      continue;
    }

    for (const { role, scope } of holders.get(slug) ?? []) {
      const variables = referenced.filter((variable) => !contextVariables[scope].includes(variable));
      if (variables.length > 0) {
        findings.push({ slug, role, scope, variables });
      }
    }
  }

  return findings;
}

/**
 * The template guard: every catalog template parses, uses only the token
 * types the factory renders, and names only variables some render context
 * supplies. Independent of role assignment — a permission nobody holds yet
 * still may not reference `{{ eventID }}`.
 */
export function findTemplateDefects(
  catalog: readonly PermissionSeedDefinition[],
  known: readonly string[],
): TemplateDefect[] {
  const findings: TemplateDefect[] = [];

  for (const { slug, conditions } of catalog) {
    const { variables, problems } = parseTemplate(conditions);

    findings.push(...problems.map((problem) => ({ slug, ...problem })));
    for (const variable of variables) {
      if (!known.includes(variable)) {
        findings.push({ slug, kind: 'unknown-variable', variable });
      }
    }
  }

  return findings;
}

interface Holder {
  role: string;
  scope: RoleScope;
}

/**
 * Slug → the roles holding it, each carrying its scope, in `rolePermissions`
 * key order and once per role. Every role is classified before its grants are
 * read, so an unclassified role is refused even when nothing it holds would
 * have been judged.
 */
function holdersBySlug(
  rolePermissions: Readonly<Record<string, readonly string[]>>,
  roleScope: Readonly<Record<string, RoleScope>>,
): Map<string, Holder[]> {
  const holders = new Map<string, Holder[]>();

  for (const [role, slugs] of Object.entries(rolePermissions)) {
    const scope = scopeOf(role, roleScope);

    for (const slug of slugs) {
      let list = holders.get(slug);
      if (list === undefined) {
        list = [];
        holders.set(slug, list);
      }
      if (!list.some((holder) => holder.role === role)) {
        list.push({ role, scope });
      }
    }
  }

  return holders;
}

function scopeOf(role: string, roleScope: Readonly<Record<string, RoleScope>>): RoleScope {
  const scope = roleScope[role];
  if (scope === undefined) {
    throw new Error(`Role '${role}' is not classified by the scope map, so its render pass is unknown`);
  }
  return scope;
}
