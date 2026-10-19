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
 *   `{ reach: 'Public' }`. Every holder reads the same rows.
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
      const entry = definedEntry(bySlug, role, slug);
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
 * A read that ignores the reach its rows' owners chose: held by a role every
 * user or guest holds, on a subject whose rows carry a `reach` column, and
 * neither bound to the caller nor testing that column. `reads` is the grant's
 * `ReadReach`, how much of the subject it reads, which is the evidence. The
 * two senses differ: `ReadReach` is a property of a grant, a row's `reach` is
 * its owner's choice.
 */
export interface ReadIgnoringReach {
  slug: string;
  role: string;
  subject: string;
  reads: Exclude<ReadReach, `binds ${string}`>;
}

/**
 * The reach guard (#495). A row's `reach` is its owner's choice of who beyond
 * them may read it, so a read every user holds must either bind the caller (an
 * own, membership or friends read, which answers who the caller is) or test
 * the column. A read that does neither hands every row its filter admits to
 * everyone, whatever its owner chose. `read:user:profile` was one: it had no
 * condition, so a profile's reach decided nothing.
 *
 * A static filter passes only when `reach` is a top-level key of its
 * conditions, where it constrains every row the grant admits. Inside an `OR`,
 * the other branch admits rows past it. Like `findUnboundedGrants`, this is a
 * tripwire, not a proof: `reach: { not: 'Private' }` passes and still reads
 * friends-only rows. A grant that binds a variable passes whatever it tests,
 * because whether its binding is the right one is the rule's own question.
 *
 * `roles` are the roles to judge: `User`, which every signed-in actor holds,
 * and `AnonymousUser`, which anyone who opens an anonymous session holds.
 * Staff read every row through the wildcard, and their own grants answer to
 * the staff allowlist. `reachSubjects` comes from {@link modelsWithField}, so
 * a subject is covered the moment its model gains the column.
 */
export function findReadsIgnoringReach(
  catalog: readonly PermissionSeedDefinition[],
  rolePermissions: Readonly<Record<string, readonly string[]>>,
  roles: readonly string[],
  reachSubjects: readonly string[],
): ReadIgnoringReach[] {
  const bySlug = new Map(catalog.map((entry) => [entry.slug, entry] as const));
  const findings: ReadIgnoringReach[] = [];

  for (const role of roles) {
    for (const slug of new Set(rolePermissions[role] ?? [])) {
      const entry = definedEntry(bySlug, role, slug);
      if (!GRANTS_READ.has(entry.action) || !reachSubjects.includes(entry.subject)) {
        continue;
      }

      const reads = reachOf(entry);
      if (reads === 'every row' || (reads === 'fixed filter' && !testsReach(asStored(entry.conditions)))) {
        findings.push({ slug, role, subject: entry.subject, reads });
      }
    }
  }

  return findings;
}

/**
 * The models whose scalar fields include `field`, read from a generated Prisma
 * namespace: each model's `<Model>ScalarFieldEnum` is a runtime object, so a
 * column is read from the client rather than listed beside it (#495). Takes
 * the namespace as an argument, the convention of every function here.
 *
 * A model with no field enum is refused rather than left out: leaving it out
 * would drop it from a guard without a word.
 */
export function modelsWithField(
  prisma: { readonly ModelName: Readonly<Record<string, string>> },
  field: string,
): string[] {
  const namespace: Readonly<Record<string, unknown>> = prisma;

  return Object.values(prisma.ModelName).filter((model) => {
    const fields = namespace[`${model}ScalarFieldEnum`];
    if (typeof fields !== 'object' || fields === null) {
      throw new Error(`No '${model}ScalarFieldEnum' for model '${model}'`);
    }

    return Object.hasOwn(fields, field);
  });
}

/** The catalog entry a role's slug names, refused when the catalog does not define it. */
function definedEntry(
  bySlug: ReadonlyMap<string, PermissionSeedDefinition>,
  role: string,
  slug: string,
): PermissionSeedDefinition {
  const entry = bySlug.get(slug);
  if (entry === undefined) {
    throw new Error(`Role '${role}' holds '${slug}', which the permission catalog does not define`);
  }

  return entry;
}

/**
 * Variables a template may name that do not vary the rows between holders of
 * one role. See `ReadReach`.
 */
const NOT_A_BINDING: ReadonlySet<string> = new Set(['role', '.']);

/**
 * Conditions as the factory will read them. The stored row went through JSON,
 * which drops an `undefined` member, so `{ createdById: undefined }` is
 * granted as `{}` — every row — whatever the object in memory looks like.
 */
function asStored(written: PermissionSeedDefinition['conditions']): unknown {
  return written === undefined ? undefined : JSON.parse(JSON.stringify(written));
}

/** Whether `reach` is a top-level key of the conditions, where it constrains every row. */
function testsReach(conditions: unknown): boolean {
  return typeof conditions === 'object' && conditions !== null && Object.hasOwn(conditions, 'reach');
}

function reachOf({ slug, conditions: written }: PermissionSeedDefinition): ReadReach {
  const conditions = asStored(written);
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
