import type { Action, Prisma, PrismaClient, RiskLevel } from '../client';
import { PermissionOwner } from '../client';
import type {
  CatalogManifest,
  CatalogSnapshot,
  FieldChange,
  ReconcilePlan,
  RolePermissionEdge,
} from './catalog-reconcile-plan';
import { countMutations, planReconcile } from './catalog-reconcile-plan';
import { PERMISSION_CATALOG } from './permission.catalog';
import { ROLE_PERMISSION_CATALOG } from './role-permission.catalog';
import { ROLE_CATALOG } from './role.catalog';
import type { PermissionSeedDefinition, RoleSeedDefinition } from './seed-definitions';

/**
 * Converges the three catalog tables to a manifest (#235).
 *
 * The seed used to overwrite every `Permission` on every run and only ever add
 * `RolePermission` rows, so an operator's edit did not survive a deploy and a
 * grant removed from the catalog was never revoked (#232, defects 1 and 2).
 * This module replaces that with plan-then-apply over `managedBy` provenance:
 * `planReconcile` decides every write from data, `applyReconcilePlan` performs
 * exactly those writes, and `reconcileCatalog` runs both in one transaction so
 * a conflict or a failed statement leaves the tables as it found them.
 *
 * What it does NOT do, by design: take an advisory lock (N instances booting at
 * once is #236's boot sequence, which wraps this call), evict caches itself
 * (it has no Redis; it hands the applied plan to an optional port and the
 * caller decides — the standalone seed passes nothing), or accept a manifest
 * from anywhere but its caller (the catalog exports are the only production
 * manifest, so CI's checks on them are a complete gate for what gets written).
 *
 * The pieces are exported separately because `npm run db:plan` wants a
 * plan-only mode (#236): `loadCatalogSnapshot` + `planReconcile` + the
 * `describe*` helpers report what a reconcile WOULD do without
 * `applyReconcilePlan`.
 */

/** The catalog this code version ships: the only manifest production passes. */
export const CATALOG_MANIFEST: CatalogManifest = {
  permissions: PERMISSION_CATALOG,
  roles: ROLE_CATALOG,
  rolePermissions: ROLE_PERMISSION_CATALOG,
};

/** Structural so Nest's `Logger` fits without this library importing it. */
export interface ReconcileLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface ReconcileCatalogOptions {
  readonly logger?: ReconcileLogger;
  /**
   * Called exactly once with the applied plan when the apply wrote anything,
   * never when it wrote nothing. Who to evict is the caller's decision — the
   * boot sequence passes its cache flush (#236); the seed CLI has no Redis
   * and passes nothing, and a warning says the caches were not touched.
   */
  readonly invalidate?: (plan: ReconcilePlan) => Promise<void>;
}

export interface ReconcileResult {
  readonly plan: ReconcilePlan;
  /** Rows written; zero means the database already matched the manifest. */
  readonly mutations: number;
  /** Whether the invalidation port was called and resolved. False when nothing was written, no port was given, or the port threw. */
  readonly invalidated: boolean;
}

/**
 * The manifest claims a row a plugin owns. Nothing is written: the plan is
 * refused before the apply starts, so the caller sees every conflict at once.
 */
export class CatalogReconcileConflictError extends Error {
  constructor(readonly conflicts: readonly string[]) {
    super(`Catalog reconcile refused, nothing written: ${conflicts.join('; ')}`);
    this.name = 'CatalogReconcileConflictError';
  }
}

/**
 * A batch statement wrote fewer rows than the plan listed: another writer
 * touched a row between the snapshot and the write. Thrown inside the
 * transaction, so nothing is committed.
 */
export class CatalogReconcileShortWriteError extends Error {
  constructor(
    readonly statement: string,
    readonly planned: number,
    readonly written: number,
  ) {
    super(
      `Catalog reconcile rolled back: ${statement} wrote ${written} of ${planned} planned row(s), so a row changed ` +
        'under the plan between the snapshot and the write. Nothing was committed; boot or seed again, which plans ' +
        'afresh from what is there now. `npm run db:plan` shows what that next reconcile would write.',
    );
    this.name = 'CatalogReconcileShortWriteError';
  }
}

function assertWrote(statement: string, written: number, planned: number): void {
  if (written !== planned) {
    throw new CatalogReconcileShortWriteError(statement, planned, written);
  }
}

/**
 * First-run cost is a handful of statements (three `createMany`, two id
 * lookups, the snapshot reads), so this is headroom for a slow CI database,
 * not a budget the happy path approaches.
 */
const RECONCILE_TRANSACTION_TIMEOUT_MS = 30_000;

const SILENT: ReconcileLogger = { log: () => undefined, warn: () => undefined };

/**
 * Plans against the live tables and applies the plan, in one transaction.
 * Returns the plan so the caller can log, assert, or invalidate from it.
 */
export async function reconcileCatalog(
  prisma: PrismaClient,
  manifest: CatalogManifest,
  options: ReconcileCatalogOptions = {},
): Promise<ReconcileResult> {
  const logger = options.logger ?? SILENT;

  const plan = await prisma.$transaction(
    async (tx) => {
      const planned = planReconcile(manifest, await loadCatalogSnapshot(tx));
      const conflicts = describeConflicts(planned);

      if (conflicts.length > 0) {
        throw new CatalogReconcileConflictError(conflicts);
      }

      await applyReconcilePlan(tx, manifest, planned);
      return planned;
    },
    { timeout: RECONCILE_TRANSACTION_TIMEOUT_MS },
  );

  const mutations = countMutations(plan);
  logger.log(summarizePlan(plan));

  for (const line of describeWrites(plan)) {
    logger.log(line);
  }

  for (const line of describeDrift(plan)) {
    logger.warn(line);
  }

  let invalidated = false;
  if (mutations > 0) {
    if (options.invalidate) {
      try {
        await options.invalidate(plan);
        invalidated = true;
      } catch (error) {
        // The writes are committed. A retry would find nothing to write and
        // never reach this call again, so failing the reconcile here would
        // lose the only chance to say the caches were missed; the TTL bounds
        // the staleness either way.
        logger.warn(
          `Catalog reconcile wrote rows but the invalidation port failed (${describeError(error)}): whatever it ` +
            'did not evict expires on its own TTL.',
        );
      }
    } else {
      logger.warn(
        'Catalog reconcile wrote rows but no invalidation port was supplied: cached ability graphs were not ' +
          'touched and expire on their own TTL.',
      );
    }
  }

  return { plan, mutations, invalidated };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads the three tables in the shape the planner compares. */
export async function loadCatalogSnapshot(client: Prisma.TransactionClient): Promise<CatalogSnapshot> {
  const permissions = await client.permission.findMany({
    select: {
      slug: true,
      action: true,
      subject: true,
      fields: true,
      conditions: true,
      inverted: true,
      reason: true,
      riskLevel: true,
      managedBy: true,
      retiredAt: true,
    },
  });
  const roles = await client.role.findMany({ select: { name: true, description: true, managedBy: true } });
  const edges = await client.rolePermission.findMany({
    select: { managedBy: true, role: { select: { name: true } }, permission: { select: { slug: true } } },
  });

  return {
    permissions,
    roles,
    rolePermissions: edges.map((edge) => ({
      roleName: edge.role.name,
      permissionSlug: edge.permission.slug,
      managedBy: edge.managedBy,
    })),
  };
}

/**
 * Performs the plan's writes and nothing else, in dependency order:
 * permissions, then roles, then the edges between them (deletes before
 * creates). Every write on an existing row is guarded by `managedBy: System`,
 * so a row whose ownership changed between the snapshot and the write is
 * never clobbered. A single-row `update` that finds no row throws on its own.
 * The batch statements (`updateMany`, `deleteMany`, and `createMany` with
 * `skipDuplicates`) would skip that row and commit the rest, so each one's
 * row count is compared to the plan and a short count throws
 * {@link CatalogReconcileShortWriteError} instead. Either way the transaction
 * rolls back and the plan the caller logs never names a write that did not
 * land (#236). Under the boot lock the only writer that can get in between is
 * an operator or a plugin. The seed CLI takes no lock and is held to the same
 * check: a hand-run `db:seed` racing an api boot, or another seed, makes one
 * of the two roll back with this error instead of both committing over each
 * other; the other converges, and booting or seeding again converges too.
 */
export async function applyReconcilePlan(
  tx: Prisma.TransactionClient,
  manifest: CatalogManifest,
  plan: ReconcilePlan,
): Promise<void> {
  const now = new Date();
  const wantedPermissions = new Map<string, PermissionSeedDefinition>(
    manifest.permissions.map((wanted) => [wanted.slug, wanted]),
  );
  const wantedRoles = new Map<string, RoleSeedDefinition>(manifest.roles.map((wanted) => [wanted.name, wanted]));

  if (plan.permissions.create.length > 0) {
    const { count } = await tx.permission.createMany({
      data: plan.permissions.create.map((wanted) => ({
        ...permissionColumns(wanted),
        slug: wanted.slug,
        managedBy: PermissionOwner.System,
      })),
      skipDuplicates: true,
    });
    assertWrote('permission.createMany', count, plan.permissions.create.length);
  }

  // A revived row converges as well: whatever drifted while it was retired.
  const converge = new Set([...plan.permissions.update.map(({ slug }) => slug), ...plan.permissions.revive]);
  for (const slug of converge) {
    await tx.permission.update({
      where: { slug, managedBy: PermissionOwner.System },
      data: { ...permissionColumns(requireDefined(wantedPermissions.get(slug), 'permission', slug)), retiredAt: null },
    });
  }

  if (plan.permissions.retire.length > 0) {
    const { count } = await tx.permission.updateMany({
      where: { slug: { in: [...plan.permissions.retire] }, managedBy: PermissionOwner.System, retiredAt: null },
      data: { retiredAt: now },
    });
    assertWrote('permission.updateMany', count, plan.permissions.retire.length);
  }

  if (plan.roles.create.length > 0) {
    const { count } = await tx.role.createMany({
      data: plan.roles.create.map((wanted) => ({
        name: wanted.name,
        description: wanted.description,
        managedBy: PermissionOwner.System,
      })),
      skipDuplicates: true,
    });
    assertWrote('role.createMany', count, plan.roles.create.length);
  }

  for (const { name } of plan.roles.update) {
    await tx.role.update({
      where: { name, managedBy: PermissionOwner.System },
      data: { description: requireDefined(wantedRoles.get(name), 'role', name).description },
    });
  }

  const edges = [...plan.rolePermissions.delete, ...plan.rolePermissions.create];
  if (edges.length === 0) {
    return;
  }

  const roleIds = new Map(
    (
      await tx.role.findMany({
        where: { name: { in: [...new Set(edges.map((edge) => edge.roleName))] } },
        select: { id: true, name: true },
      })
    ).map((role) => [role.name, role.id]),
  );
  const permissionIds = new Map(
    (
      await tx.permission.findMany({
        where: { slug: { in: [...new Set(edges.map((edge) => edge.permissionSlug))] } },
        select: { id: true, slug: true },
      })
    ).map((permission) => [permission.slug, permission.id]),
  );
  const resolve = (edge: RolePermissionEdge): { roleId: string; permissionId: string } => ({
    roleId: requireDefined(roleIds.get(edge.roleName), 'role', edge.roleName),
    permissionId: requireDefined(permissionIds.get(edge.permissionSlug), 'permission', edge.permissionSlug),
  });

  if (plan.rolePermissions.delete.length > 0) {
    const { count } = await tx.rolePermission.deleteMany({
      where: { managedBy: PermissionOwner.System, OR: plan.rolePermissions.delete.map(resolve) },
    });
    assertWrote('rolePermission.deleteMany', count, plan.rolePermissions.delete.length);
  }

  if (plan.rolePermissions.create.length > 0) {
    const { count } = await tx.rolePermission.createMany({
      data: plan.rolePermissions.create.map((edge) => ({ ...resolve(edge), managedBy: PermissionOwner.System })),
      skipDuplicates: true,
    });
    assertWrote('rolePermission.createMany', count, plan.rolePermissions.create.length);
  }
}

/** Every conflict in the plan as a sentence; non-empty means the apply must not run. */
export function describeConflicts(plan: ReconcilePlan): string[] {
  return [
    ...plan.permissions.conflicts.map(({ slug }) => `permission '${slug}' is Plugin-owned but the manifest defines it`),
    ...plan.roles.conflicts.map(({ name }) => `role '${name}' is Plugin-owned but the manifest defines it`),
    ...plan.rolePermissions.conflicts.map(
      ({ roleName, permissionSlug }) =>
        `grant '${roleName} → ${permissionSlug}' is Plugin-owned but the manifest lists it`,
    ),
  ];
}

/** One line: what the apply wrote, by table. */
export function summarizePlan(plan: ReconcilePlan): string {
  const { permissions, roles, rolePermissions } = plan;
  return (
    `Catalog reconcile: permissions +${permissions.create.length} ~${permissions.update.length} ` +
    `revived ${permissions.revive.length} retired ${permissions.retire.length}; ` +
    `roles +${roles.create.length} ~${roles.update.length}; ` +
    `grants +${rolePermissions.create.length} -${rolePermissions.delete.length}`
  );
}

/**
 * Every write that changes or removes authority, one line each: updated
 * permissions and roles with their field changes, revived and retired slugs,
 * revoked grants. Creates only add and stay counted by the summary — the
 * first run would otherwise print one line per catalog entry.
 */
export function describeWrites(plan: ReconcilePlan): string[] {
  const lines: string[] = [];

  for (const { slug, changes } of plan.permissions.update) {
    lines.push(`permission '${slug}' updated: ${formatChanges(changes)}`);
  }
  for (const slug of plan.permissions.revive) {
    lines.push(`permission '${slug}' revived`);
  }
  for (const slug of plan.permissions.retire) {
    lines.push(`permission '${slug}' retired`);
  }
  for (const { name, changes } of plan.roles.update) {
    lines.push(`role '${name}' updated: ${formatChanges(changes)}`);
  }
  for (const { roleName, permissionSlug } of plan.rolePermissions.delete) {
    lines.push(`grant '${roleName} → ${permissionSlug}' revoked`);
  }

  return lines;
}

/**
 * The drift report: every row the reconciler saw and left alone, with why.
 * This is the answer to "which permissions have operators modified?".
 */
export function describeDrift(plan: ReconcilePlan): string[] {
  const lines: string[] = [];

  for (const { slug, managedBy, drift } of plan.permissions.skipped) {
    lines.push(`${managedBy}-owned permission '${slug}' left alone${describeChanges(drift)}`);
  }
  for (const { slug, managedBy } of plan.permissions.retained) {
    lines.push(`${managedBy}-owned permission '${slug}' is not in the manifest; retained`);
  }
  for (const { name, managedBy, drift } of plan.roles.skipped) {
    lines.push(`${managedBy}-owned role '${name}' left alone${describeChanges(drift)}`);
  }
  for (const name of plan.roles.orphans) {
    // The row is kept — that is what "never mutated" covers; its System grants
    // follow the RolePermission rule and are revoked with the rest.
    const revoked = plan.rolePermissions.delete.filter((edge) => edge.roleName === name).length;
    lines.push(
      `System-owned role '${name}' is not in the manifest; the row is kept, ${revoked} of its System grants ` +
        `${revoked === 1 ? 'is' : 'are'} revoked`,
    );
  }
  for (const { roleName, permissionSlug, managedBy } of plan.rolePermissions.retained) {
    lines.push(`${managedBy}-owned grant '${roleName} → ${permissionSlug}' is not in the manifest; retained`);
  }

  return lines;
}

function describeChanges(changes: readonly FieldChange[]): string {
  return changes.length === 0 ? '; no drift' : `; drift: ${formatChanges(changes)}`;
}

function formatChanges(changes: readonly FieldChange[]): string {
  return changes.map(({ field, from, to }) => `${field} ${JSON.stringify(from)} → ${JSON.stringify(to)}`).join(', ');
}

/** The `Permission` columns the manifest owns, in the shape the write side takes. */
interface PermissionColumns {
  readonly action: Action;
  readonly subject: string;
  readonly fields: string[];
  readonly conditions: Prisma.InputJsonObject;
  readonly inverted: false;
  readonly reason: string;
  readonly riskLevel: RiskLevel;
}

/** The columns the manifest owns, in the form the column write has always taken them. */
function permissionColumns(wanted: PermissionSeedDefinition): PermissionColumns {
  return {
    action: wanted.action,
    subject: wanted.subject,
    fields: [...(wanted.fields ?? [])],
    conditions: wanted.conditions ?? {},
    inverted: false,
    reason: wanted.reason,
    riskLevel: wanted.riskLevel,
  };
}

function requireDefined<T>(value: T | undefined, kind: string, key: string): T {
  if (value === undefined) {
    throw new Error(
      `Catalog reconcile plan names ${kind} '${key}', which neither the manifest nor the database defines`,
    );
  }

  return value;
}
