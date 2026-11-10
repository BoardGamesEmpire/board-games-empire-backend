import { PrismaError } from '@status/codes';
import * as Mustache from 'mustache';
import { stripVTControlCharacters } from 'node:util';
import { PluginGrantScope, Prisma, SystemRole } from '../client';
import { sqlStateOf } from '../utils/deadlock';
import { hasBoundingConditions } from '../utils/permission-conditions';
import {
  findEventSpanningGrants,
  findShorthandRelationConditions,
  findTemplateDefects,
  findUnboundedGrants,
  findUnconditionedGlobalGrants,
  findUnconditionedScopedGrants,
  findUnrenderableTemplateGrants,
  parseTemplate,
  type TemplateDefect,
} from './catalog-guards';
import { findReadsIgnoringReach, modelsWithField, type ReadIgnoringReach } from './catalog-read-ceilings';
import type { CatalogManifest, CatalogSnapshot, PermissionSnapshotRow } from './catalog-reconcile-plan';
import { PAIRED_GRANTS } from './role-permission.catalog';
import { KNOWN_TEMPLATE_VARIABLES, RENDER_CONTEXT_VARIABLES, ROLE_SCOPE } from './role.catalog';
import type { PermissionSeedDefinition } from './seed-definitions';

/**
 * The entry check (#772): whether a permission catalog entry edited on a
 * running server is sound. The Owner's edit is checked when it is saved, and
 * every start checks again each entry the Owner edited, because a newer
 * version of the server can make an edit that once passed fail.
 *
 * Two halves. {@link checkCatalogEntries} runs the catalog guards
 * (`catalog-guards.ts`) over the catalog before and after the edit and reports
 * only what the edit adds, so a finding the shipped catalog already has never
 * blocks an edit. `probeConditions` asks Prisma itself to judge a
 * condition's field paths, operators and values.
 */

/** The live catalog as the guards read it: unretired permissions, unrevoked grants. */
export interface CatalogView {
  readonly permissions: readonly PermissionSeedDefinition[];
  readonly rolePermissions: Readonly<Record<string, readonly string[]>>;
}

/** Why an entry is refused. */
export type EntryProblem =
  | { readonly kind: 'template'; readonly slug: string; readonly detail: string }
  | { readonly kind: 'shorthand-relation'; readonly slug: string; readonly path: string }
  | { readonly kind: 'fails-open'; readonly slug: string; readonly role: string }
  | {
      readonly kind: 'cannot-render';
      readonly slug: string;
      readonly role: string;
      readonly variables: readonly string[];
    }
  | { readonly kind: 'unbounded-on-floor-role'; readonly slug: string; readonly role: string }
  | {
      readonly kind: 'reads-past-reach';
      readonly slug: string;
      readonly role: string;
      readonly subject: string;
      /** How much of the resource type the read reaches: every row, or every row a fixed filter admits. */
      readonly reads: ReadIgnoringReach['reads'];
    }
  | { readonly kind: 'event-spanning'; readonly slug: string; readonly role: string }
  | {
      readonly kind: 'names-other-roles';
      readonly slug: string;
      readonly role: string;
      readonly named: readonly string[];
    }
  | { readonly kind: 'subject-has-no-model'; readonly slug: string; readonly subject: string }
  | { readonly kind: 'query-rejected'; readonly slug: string; readonly message: string };

/** What an entry is allowed with, but reported. */
export type EntryWarning =
  | { readonly kind: 'unconditioned-global'; readonly slug: string; readonly role: string }
  | {
      readonly kind: 'unpaired';
      /** The slug the role holds. */
      readonly slug: string;
      readonly role: string;
      /** The slugs that would pair it, none of which the role holds. */
      readonly partners: readonly string[];
    };

/** A target is a permission (every holder is judged) or one grant. */
export type EntryTarget = { readonly slug: string } | { readonly roleName: string; readonly slug: string };

/**
 * The catalog in a database snapshot, as the ability loaders read it: no
 * retired permission, no revoked grant, and no grant of a permission the view
 * leaves out.
 *
 * It also leaves out the grants of any role `ROLE_SCOPE` does not classify: a
 * role a newer version of the server no longer ships, or a custom role
 * (#1170). Which render pass such a role arrives through is unknown, so the
 * guards refuse to judge it and would throw on the whole view. Leaving it out
 * keeps one such role from stopping the check, and with it a start, for every
 * other entry. Its grants go unjudged until the scope map classifies it.
 */
export function catalogViewFromSnapshot(snapshot: CatalogSnapshot): CatalogView {
  const permissions = snapshot.permissions.filter(({ retiredAt }) => retiredAt === null).map(asDefinition);
  const live = new Set(permissions.map(({ slug }) => slug));
  const rolePermissions = new Map<string, string[]>();

  for (const { roleName, permissionSlug, revokedAt } of snapshot.rolePermissions) {
    if (revokedAt !== null || !live.has(permissionSlug) || !Object.hasOwn(ROLE_SCOPE, roleName)) {
      continue;
    }

    const slugs = rolePermissions.get(roleName);
    if (slugs === undefined) {
      rolePermissions.set(roleName, [permissionSlug]);
    } else {
      slugs.push(permissionSlug);
    }
  }

  return { permissions, rolePermissions: Object.fromEntries(rolePermissions) };
}

/** The permission catalog as this version of the server ships it. */
export function catalogViewFromManifest(manifest: CatalogManifest): CatalogView {
  return { permissions: manifest.permissions, rolePermissions: manifest.rolePermissions };
}

/**
 * Problems and warnings `after` has for the targets that `baseline` doesn't.
 * Pure.
 *
 * Every guard runs over both views. A finding is kept when it concerns a
 * target: its slug is the target's, and for a grant target its role is the
 * target's role too. A finding about a permission alone, such as a condition
 * that does not parse, has no role and is kept on the slug. An `unpaired`
 * warning is also kept when the target is one of its `partners`, because
 * revoking one half of a pair is reported on the half the role keeps.
 *
 * A grant on the base role, `User`, is judged as its permission instead, on
 * every holder. The unconditioned-grant guards excuse any other role holding
 * a slug `User` holds, so giving or taking that grant changes what the guards
 * say about roles the target does not name.
 *
 * Then only the findings `baseline` lacks are returned. Two findings are the
 * same when they say the same thing, whatever order their lists come in: the
 * database stores a condition as `jsonb`, which reorders its keys, so a
 * snapshot's condition can name its variables in another order than the
 * permission catalog's.
 *
 * A view from a snapshot never holds a role `ROLE_SCOPE` does not classify.
 * A hand-built view or manifest that does makes this throw, as the guards do.
 */
export function checkCatalogEntries(
  baseline: CatalogView,
  after: CatalogView,
  targets: readonly EntryTarget[],
): { problems: EntryProblem[]; warnings: EntryWarning[] } {
  return newEntryFindings(catalogFindings(baseline), catalogFindings(after), targets);
}

/** Every finding of every catalog guard on one view, problems and warnings. */
export interface CatalogFindings {
  readonly problems: readonly EntryProblem[];
  readonly warnings: readonly EntryWarning[];
}

/**
 * What `now` has for the targets that `before` doesn't: {@link checkCatalogEntries}
 * on findings {@link catalogFindings} already ran, so it runs no guard. Pure.
 */
export function newEntryFindings(
  before: CatalogFindings,
  now: CatalogFindings,
  targets: readonly EntryTarget[],
): { problems: EntryProblem[]; warnings: EntryWarning[] } {
  return {
    problems: newFindings(before.problems, now.problems, targets),
    warnings: newFindings(before.warnings, now.warnings, targets),
  };
}

/**
 * Role names the conditions compare a role's `name` against: a string, an
 * `equals` or the members of an `in` under a `name` key whose path passes
 * through a `role` key, keeping only names of a `SystemRole`. Each name once,
 * in order of first use.
 *
 * It reads where a name appears, not what the clause around it means: a name
 * under `not` or `isNot` counts as named too. No shipped condition names a role
 * that way.
 */
export function namedRoles(conditions: unknown): readonly string[] {
  const named = new Set<string>();

  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      if (SYSTEM_ROLES.has(value)) {
        named.add(value);
      }
      return;
    }

    if (isObject(value)) {
      collect(value['equals']);
      if (Array.isArray(value['in'])) {
        value['in'].forEach(collect);
      }
    }
  };

  const walk = (node: unknown, underRole: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, underRole));
      return;
    }

    if (!isObject(node)) {
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'name' && underRole) {
        collect(value);
      }
      walk(value, underRole || key === 'role');
    }
  };

  walk(conditions, false);

  return [...named];
}

/**
 * Prisma's verdict on a condition, with placeholders rendered to sample values.
 *
 * The condition is rendered the way the ability factory renders it, against
 * a context holding every variable some render pass supplies, and run as the
 * `where` of a count on the permission's resource type, ANDed with a lookup
 * of one sample primary key. Prisma validates the whole `where` and Postgres
 * binds every value before any row is read, so the lookup changes no verdict;
 * it keeps the count to an index probe, where the condition alone could scan
 * the table. The probe runs at every start for each permission the Owner
 * edited, and on every edit (#772). Prisma's own
 * validation is the authority on field paths, operators and value types: a
 * column the schema no longer has, an operator where it does not belong, or a
 * placeholder in an enum column is refused before any statement is sent
 * (#772). A value only Postgres refuses is reported the same way: a number
 * past an `integer` column's range comes back as a known request error, and a
 * NUL byte in a string as the driver adapter's own error, SQLSTATE class 22.
 * A condition that renders to text that is not JSON is a `template` problem.
 * The Owner's input never makes the probe throw.
 *
 * `client` must be an interactive transaction's client. The count runs inside
 * a savepoint, released when it passes and rolled back to when it fails,
 * because a statement Postgres refuses aborts the whole transaction it runs
 * in, and the caller's transaction is the start's reconcile or the Owner's
 * edit. Probe one permission at a time: the savepoint name is fixed.
 *
 * Nothing is probed for an absent or empty condition, nor for a condition
 * that does not parse, which the template guard reports. A condition on a
 * resource type with no Prisma model, such as `all`, cannot be judged by any
 * query and is refused. An error that is a verdict on the database rather
 * than the condition, a lost connection or a closed transaction say, is
 * thrown.
 */
export async function probeConditions(
  client: Prisma.TransactionClient,
  permission: Pick<PermissionSeedDefinition, 'slug' | 'subject' | 'conditions'>,
): Promise<EntryProblem[]> {
  const { slug, subject, conditions } = permission;
  if (!hasBoundingConditions(conditions) || parseTemplate(conditions).problems.length > 0) {
    return [];
  }

  if (!PRISMA_MODELS.has(subject)) {
    return [{ kind: 'subject-has-no-model', slug, subject }];
  }

  let where: unknown;
  try {
    where = JSON.parse(Mustache.render(JSON.stringify(conditions), PROBE_CONTEXT));
  } catch (error) {
    // A condition can parse as a template and still render to text that is
    // not JSON: a section spanning a key and a value drops the text between.
    // The ability factory would fail the same way on every render.
    return [{ kind: 'template', slug, detail: `render-failed: ${describeError(error)}` }];
  }

  const models = client as unknown as Readonly<Record<string, CountDelegate>>;

  await client.$executeRawUnsafe(`SAVEPOINT ${PROBE_SAVEPOINT}`);
  try {
    await models[lowerFirst(subject)].count(boundedProbe(subject, where));
  } catch (error) {
    await client.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${PROBE_SAVEPOINT}`);

    if (isVerdictOnCondition(error)) {
      return [{ kind: 'query-rejected', slug, message: reasonLine(error.message) }];
    }
    throw error;
  }
  await client.$executeRawUnsafe(`RELEASE SAVEPOINT ${PROBE_SAVEPOINT}`);

  return [];
}

interface CountArgs {
  readonly where: unknown;
  readonly take?: number;
}

interface CountDelegate {
  count(args: CountArgs): Promise<number>;
}

/**
 * The probe's count: the condition ANDed with a lookup of one sample `id`, so
 * the database reads at most one row through the primary key whatever the
 * condition names. A model with no `id` column, of which there are a few small
 * ones, is counted with `take: 1` instead, which stops at the first match.
 */
function boundedProbe(subject: string, where: unknown): CountArgs {
  return MODELS_WITH_ID.has(subject) ? { where: { AND: [{ id: PROBE_SAMPLE_ID }, where] } } : { where, take: 1 };
}

/**
 * Whether a failed probe is a verdict on the condition rather than on the
 * database: Prisma's validation, a database error Prisma knows, or a data
 * exception (SQLSTATE class 22) the driver adapter throws bare, such as a NUL
 * byte in a string. A known request error that reports the database or the
 * transaction rather than the query (a lost connection, a pool or transaction
 * timeout, a write conflict) is not one, so it is thrown: at a start it must
 * not retire the permission, and on an edit it must not answer 422 blaming the
 * Owner's condition (#772).
 */
function isVerdictOnCondition(error: unknown): error is Error {
  if (error instanceof Prisma.PrismaClientValidationError) {
    return true;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return !isInfrastructureCode(error.code);
  }

  return (
    error instanceof Error &&
    error.name === 'DriverAdapterError' &&
    (sqlStateOf(error.cause)?.startsWith(DATA_EXCEPTION_CLASS) ?? false)
  );
}

/** SQLSTATE class 22, data exception: a value in the statement Postgres cannot take. */
const DATA_EXCEPTION_CLASS = '22';

/**
 * Prisma's codes for a failure of the database or the transaction rather
 * than the query: every `P1` code (connecting, authenticating, the server
 * closing the connection), and these.
 */
const INFRASTRUCTURE_CODES: ReadonlySet<string> = new Set<string>([
  PrismaError.ConnectionPoolTimeout,
  PrismaError.TransactionApiError,
  PrismaError.TransactionWriteConflict,
  PrismaError.TooManyDatabaseConnections,
]);

function isInfrastructureCode(code: string): boolean {
  return code.startsWith('P1') || INFRASTRUCTURE_CODES.has(code);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A constant, never input: the probe's savepoint is named in raw SQL. */
const PROBE_SAVEPOINT = 'catalog_entry_probe';

/** Read from the generated client, so a model is probed the moment the schema has it. */
const PRISMA_MODELS: ReadonlySet<string> = new Set(Object.values(Prisma.ModelName));

/** The models whose primary key is an `id` column, read from the generated client like {@link PRISMA_MODELS}. */
const MODELS_WITH_ID: ReadonlySet<string> = new Set(modelsWithField(Prisma, 'id'));

/**
 * What a placeholder renders to in the probe: a value of the right kind for
 * the two variables that hold an enum value or a name (`role` is a role's
 * name, compared against `Role.name`), and a well-formed id for every other.
 */
const PROBE_SAMPLE_ID = 'c0probe0000000000000000000';
const PROBE_SAMPLE_VALUES: Readonly<Record<string, string>> = {
  role: SystemRole.User,
  'unit.scopeType': PluginGrantScope.Household,
};

/** Every variable a condition may name, each at its path, holding its sample value. */
const PROBE_CONTEXT: Readonly<Record<string, unknown>> = sampleContext(KNOWN_TEMPLATE_VARIABLES);

function sampleContext(variables: readonly string[]): Record<string, unknown> {
  const context: Record<string, unknown> = {};

  for (const variable of variables) {
    const keys = variable.split('.');
    const leaf = keys.pop() as string;
    let node = context;
    for (const key of keys) {
      node = (node[key] ??= {}) as Record<string, unknown>;
    }
    node[leaf] = PROBE_SAMPLE_VALUES[variable] ?? PROBE_SAMPLE_ID;
  }

  return context;
}

/** The client's delegate for a model: `GamePlaySession` is `gamePlaySession`. */
function lowerFirst(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/**
 * The line of a Prisma error that says why. Prisma prints the invocation, the
 * caller's file and the query above it, which say nothing about the condition
 * and name paths on the server, so only the last line is kept.
 */
function reasonLine(message: string): string {
  const lines = stripVTControlCharacters(message)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines[lines.length - 1] ?? '';
}

const SYSTEM_ROLES: ReadonlySet<string> = new Set(Object.values(SystemRole));

/** The base role: every signed-in actor holds it, and the unconditioned-grant guards exempt what it holds. */
const BASE_ROLE = SystemRole.User;

/** No role has an empty name, so naming it as the base role exempts nothing. */
const NO_ROLE = '';

/**
 * The resource types whose rows carry a `reach`, read from the generated
 * client, and `all`: a grant on every resource type reaches those too, so
 * given to the base role it reads past every row's reach (#772).
 */
const REACH_SUBJECTS: readonly string[] = [...modelsWithField(Prisma, 'reach'), 'all'];

/**
 * Every guard over one view, each finding in the entry check's shape. A
 * caller judging many targets, or the same view again, runs this once per
 * view and picks each target's findings with {@link newEntryFindings}: a start
 * judges each of the Owner's grants on its own (#772), and running the guards
 * over the whole catalog twice for each grant made that quadratic.
 *
 * The arguments are the ones the shipped catalog's own specs pass each guard:
 * `ROLE_SCOPE`, the render contexts, `User` as the base role every
 * unconditioned-grant guard exempts, `AnonymousUser` as the floor role, and
 * both as the roles the reach guard judges.
 *
 * The base role's own unconditioned grants are reported apart, as a warning.
 * Both unconditioned-grant guards skip every slug it holds, which left the
 * broadest grant of all, one every user holds, unreported. The global guard
 * runs again with no role exempt, and only the base role's findings are kept.
 * A warning rather than a problem: the Owner may mean to give every user a
 * power, and fail-open names a scoped role's grant (#772).
 *
 * The reach guard judges only the permissions whose condition parses, and
 * only their grants. It refuses to classify a template it cannot parse by
 * throwing, which would stop the check, and a start with it, before the
 * template guard reports the typo; that report is the finding (#772).
 */
export function catalogFindings({ permissions, rolePermissions }: CatalogView): CatalogFindings {
  const parsing = permissions.filter(({ conditions }) => parseTemplate(conditions).problems.length === 0);
  const parses = new Set(parsing.map(({ slug }) => slug));
  const parsingGrants = Object.fromEntries(
    Object.entries(rolePermissions).map(([role, slugs]) => [role, slugs.filter((slug) => parses.has(slug))]),
  );

  const problems: EntryProblem[] = [
    ...findTemplateDefects(permissions, KNOWN_TEMPLATE_VARIABLES).map(
      (defect): EntryProblem => ({ kind: 'template', slug: defect.slug, detail: describeTemplateDefect(defect) }),
    ),
    ...findShorthandRelationConditions(permissions).map(
      ({ slug, path }): EntryProblem => ({ kind: 'shorthand-relation', slug, path }),
    ),
    ...findUnconditionedScopedGrants(permissions, rolePermissions, ROLE_SCOPE, BASE_ROLE).map(
      ({ slug, role }): EntryProblem => ({ kind: 'fails-open', slug, role }),
    ),
    ...findUnrenderableTemplateGrants(permissions, rolePermissions, ROLE_SCOPE, RENDER_CONTEXT_VARIABLES).map(
      ({ slug, role, variables }): EntryProblem => ({ kind: 'cannot-render', slug, role, variables }),
    ),
    ...findUnboundedGrants(permissions, rolePermissions, SystemRole.AnonymousUser).map(
      ({ slug, role }): EntryProblem => ({ kind: 'unbounded-on-floor-role', slug, role }),
    ),
    ...findReadsIgnoringReach(parsing, parsingGrants, [BASE_ROLE, SystemRole.AnonymousUser], REACH_SUBJECTS).map(
      ({ slug, role, subject, reads }): EntryProblem => ({ kind: 'reads-past-reach', slug, role, subject, reads }),
    ),
    ...findEventSpanningGrants(permissions, rolePermissions, ROLE_SCOPE).map(
      ({ slug, role }): EntryProblem => ({ kind: 'event-spanning', slug, role }),
    ),
    ...findGrantsNamingOtherRoles(permissions, rolePermissions),
  ];

  const warnings: EntryWarning[] = [
    ...findUnconditionedGlobalGrants(permissions, rolePermissions, ROLE_SCOPE, BASE_ROLE).map(
      ({ slug, role }): EntryWarning => ({ kind: 'unconditioned-global', slug, role }),
    ),
    ...findUnconditionedGlobalGrants(permissions, rolePermissions, ROLE_SCOPE, NO_ROLE)
      .filter(({ role }) => role === BASE_ROLE)
      .map(({ slug, role }): EntryWarning => ({ kind: 'unconditioned-global', slug, role })),
    ...findUnpairedGrants(rolePermissions),
  ];

  return { problems, warnings };
}

/**
 * A role holding a permission whose conditions name roles, none of them it
 * (#772). Most such conditions compare the acting user's role assignment
 * against those names, so held by any other role the grant confers nothing:
 * the inert grant the catalog guards exist to catch.
 *
 * The check reads names, not whose role they are. A condition naming the role
 * of another row reads the same way: `create:event_attendee:attending-role`
 * names the roles an organizer may give an attendee, and its two shipped
 * holders are reported. Those findings are in every baseline, so they never
 * block an edit, but giving such a grant to one more role is refused.
 */
function findGrantsNamingOtherRoles(
  permissions: readonly PermissionSeedDefinition[],
  rolePermissions: Readonly<Record<string, readonly string[]>>,
): EntryProblem[] {
  const bySlug = new Map(permissions.map((entry) => [entry.slug, entry] as const));
  const findings: EntryProblem[] = [];

  for (const [role, slugs] of Object.entries(rolePermissions)) {
    for (const slug of new Set(slugs)) {
      const named = namedRoles(bySlug.get(slug)?.conditions);
      if (named.length > 0 && !named.includes(role)) {
        findings.push({ kind: 'names-other-roles', slug, role, named });
      }
    }
  }

  return findings;
}

/** Each role holding one half of a `PAIRED_GRANTS` pair without the other (#772). */
function findUnpairedGrants(rolePermissions: Readonly<Record<string, readonly string[]>>): EntryWarning[] {
  const findings: EntryWarning[] = [];
  const firsts = [...new Set(PAIRED_GRANTS.map(([first]) => first))];
  const seconds = [...new Set(PAIRED_GRANTS.map(([, second]) => second))];

  for (const [role, slugs] of Object.entries(rolePermissions)) {
    const held = new Set(slugs);
    const unpaired = (slug: string, partners: readonly string[]): void => {
      if (held.has(slug) && !partners.some((partner) => held.has(partner))) {
        findings.push({ kind: 'unpaired', slug, role, partners });
      }
    };

    for (const first of firsts) {
      unpaired(
        first,
        PAIRED_GRANTS.filter(([slug]) => slug === first).map(([, second]) => second),
      );
    }
    for (const second of seconds) {
      unpaired(
        second,
        PAIRED_GRANTS.filter(([, slug]) => slug === second).map(([first]) => first),
      );
    }
  }

  return findings;
}

function newFindings<T extends EntryProblem | EntryWarning>(
  baseline: readonly T[],
  after: readonly T[],
  targets: readonly EntryTarget[],
): T[] {
  const known = new Set(baseline.map(sameness));

  return after.filter(
    (finding) => targets.some((target) => concerns(target, finding)) && !known.has(sameness(finding)),
  );
}

function concerns(target: EntryTarget, finding: EntryProblem | EntryWarning): boolean {
  const slugs = finding.kind === 'unpaired' ? [finding.slug, ...finding.partners] : [finding.slug];
  if (!slugs.includes(target.slug)) {
    return false;
  }

  return (
    !('roleName' in target) || target.roleName === BASE_ROLE || !('role' in finding) || finding.role === target.roleName
  );
}

/** A finding as `JSON.stringify` writes it, with each list in it sorted. */
function sameness(finding: EntryProblem | EntryWarning): string {
  return JSON.stringify(finding, (_key, value: unknown) => (Array.isArray(value) ? [...value].sort() : value));
}

function describeTemplateDefect(defect: TemplateDefect): string {
  switch (defect.kind) {
    case 'malformed-template':
      return `${defect.kind}: ${defect.message}`;
    case 'unsupported-token-type':
      return `${defect.kind}: ${defect.tokenType}`;
    case 'unknown-variable':
      return `${defect.kind}: ${defect.variable}`;
  }
}

/** A `Permission` row in the shape the catalog declares it. */
function asDefinition(row: PermissionSnapshotRow): PermissionSeedDefinition {
  return {
    action: row.action,
    subject: row.subject as PermissionSeedDefinition['subject'],
    slug: row.slug,
    riskLevel: row.riskLevel,
    reason: row.reason ?? '',
    ...(row.conditions === null ? {} : { conditions: row.conditions as Prisma.InputJsonObject }),
    ...(row.fields.length === 0 ? {} : { fields: row.fields }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
