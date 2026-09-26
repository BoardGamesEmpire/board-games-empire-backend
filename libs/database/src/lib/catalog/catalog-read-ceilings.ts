import { Action } from '../client';
import { hasBoundingConditions } from '../utils/permission-conditions';
import { parseTemplate } from './catalog-guards';
import type { PermissionSeedDefinition } from './seed-definitions';

/**
 * How much of its subject one read grant reaches, which is the fact that
 * decides whether a list over that subject varies by caller (#365, #415):
 *
 * - `'every row'` — no conditions. Every holder reads the whole table.
 * - `'fixed filter'` — conditions with nothing templated, such as
 *   `{ visibility: 'Public' }`. Every holder reads the same rows.
 * - `'binds …'` — the template variables the conditions are rendered against,
 *   sorted. `user.id` varies the rows per caller, `householdId` per
 *   membership, `eventId` per attendance. `role` is not listed: the pass
 *   renders it as the holding role's own name, so it is the same for every
 *   holder and a clause on it alone is a fixed filter. Nor is a section's
 *   implicit `.`, which its opener already names.
 *
 * Three values rather than "conditioned or not", because non-empty is not
 * narrow: `{ deletedAt: null }` admits every live row. A grant that lost its
 * `{{ user.id }}` and kept a static clause would still read as conditioned,
 * and that loss is the change that turns a personal list install-wide.
 *
 * It is a class, not a condition diff. It says what a grant binds, not what
 * its clause admits, so two widenings sit below its resolution: a template
 * with a static `OR` branch added still reads `binds …`, and one static filter
 * swapped for a wider one is still `'fixed filter'`. Pinning the clauses would
 * catch those, at the cost of transcribing the catalog beside itself.
 */
export type ReadReach = 'every row' | 'fixed filter' | `binds ${string}`;

/** Subject → role → slug → reach. A subject no role reads maps to `{}`. */
export type ReadCeilings = Record<string, Record<string, Record<string, ReadReach>>>;

/** `manage` is CASL's any-action, so it grants a read as surely as `read` does. */
const GRANTS_READ: ReadonlySet<Action> = new Set([Action.read, Action.manage]);

/**
 * Each role's read ceiling on each subject, derived from the catalogs rather
 * than written down, so it cannot go stale beside them (#415). The shipped
 * result is pinned in `known-read-ceilings.spec.ts`.
 *
 * `subjects` is the complete list to report — every `ResourceType` plus
 * `'all'` for the shipped catalog. A subject with no grant comes back as `{}`
 * instead of being left out, because "only the wildcards reach it" is itself
 * a ceiling worth seeing. A grant on a subject the list omits is refused, not
 * dropped. The wildcards stay under `'all'` and are not copied onto every
 * subject: repeating them under each one would bury the rest.
 *
 * Rows only. `fields` narrows which columns a grant reads, never which rows.
 *
 * Catalog roles only, and each role alone. The ability factory adds direct
 * `UserPermission` grants and denials on top of roles, and plugins hold grants
 * of their own; both are runtime rows, not catalog entries. And a caller's
 * ceiling is the union of every role they hold, which this does not compute.
 *
 * Everything is taken as an argument, nothing defaulted, the same convention
 * as `catalog-guards.ts`, so fixtures and the shipped catalogs share one path.
 */
export function deriveReadCeilings(
  catalog: readonly PermissionSeedDefinition[],
  rolePermissions: Readonly<Record<string, readonly string[]>>,
  subjects: readonly string[],
): ReadCeilings {
  const bySlug = new Map(catalog.map((entry) => [entry.slug, entry] as const));
  const ceilings = new Map(subjects.map((subject) => [subject, new Map<string, Map<string, ReadReach>>()]));

  for (const [role, slugs] of Object.entries(rolePermissions)) {
    for (const slug of slugs) {
      const entry = bySlug.get(slug);
      if (entry === undefined) {
        throw new Error(`Role '${role}' holds '${slug}', which the permission catalog does not define`);
      }

      if (!GRANTS_READ.has(entry.action)) {
        continue;
      }

      const bySubject = ceilings.get(entry.subject);
      if (bySubject === undefined) {
        throw new Error(`'${slug}' grants a read on '${entry.subject}', which is not in the subject list`);
      }

      let byRole = bySubject.get(role);
      if (byRole === undefined) {
        byRole = new Map();
        bySubject.set(role, byRole);
      }
      byRole.set(slug, reachOf(entry));
    }
  }

  // Built in Maps and handed out as plain objects. `Object.fromEntries` defines
  // each key as an own property, so a subject, role or slug spelled like an
  // `Object.prototype` member (`constructor`, `__proto__`) lands as data at
  // every level instead of finding an inherited value or setting a prototype.
  return Object.fromEntries(
    [...ceilings].map(([subject, roles]) => [
      subject,
      Object.fromEntries([...roles].map(([role, grants]) => [role, Object.fromEntries(grants)])),
    ]),
  );
}

/**
 * Variables a template may name that do not vary the rows between holders of
 * one role. See `ReadReach`.
 */
const NOT_A_BINDING: ReadonlySet<string> = new Set(['role', '.']);

function reachOf({ slug, conditions: written }: PermissionSeedDefinition): ReadReach {
  // Classified as the factory will read it. The stored row went through JSON,
  // which drops an `undefined` member, so `{ createdById: undefined }` is
  // granted as `{}` — every row — whatever the object in memory looks like.
  const conditions: unknown = written === undefined ? undefined : JSON.parse(JSON.stringify(written));
  if (!hasBoundingConditions(conditions)) {
    return 'every row';
  }

  // A template that does not parse is `findTemplateDefects`'s to report. This
  // refuses to classify it rather than guessing what it would have bound, and
  // names the problem so the failure here is not the less useful of the two.
  const { variables, problems } = parseTemplate(conditions);
  if (problems.length > 0) {
    const why = problems
      .map((problem) =>
        problem.kind === 'malformed-template' ? problem.message : `unsupported token type '${problem.tokenType}'`,
      )
      .join('; ');

    throw new Error(`'${slug}' has a conditions template that cannot be rendered (${why}), so its reach is unknown`);
  }

  const bound = variables.filter((variable) => !NOT_A_BINDING.has(variable));

  return bound.length === 0 ? 'fixed filter' : `binds ${bound.sort().join(', ')}`;
}
