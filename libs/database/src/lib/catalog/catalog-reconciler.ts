import type { Action, Prisma, PrismaClient, RiskLevel } from '../client';
import { PermissionOwner } from '../client';
import { lockCatalogEdits } from './catalog-edit-lock';
import type { CatalogFindings, EntryProblem } from './catalog-entry-check';
import {
  catalogFindings,
  catalogViewFromManifest,
  catalogViewFromSnapshot,
  newEntryFindings,
  probeConditions,
} from './catalog-entry-check';
import type {
  CatalogManifest,
  CatalogSnapshot,
  FailingEntries,
  FieldChange,
  PermissionSnapshotRow,
  ReconcilePlan,
  RolePermissionEdge,
  RolePermissionSnapshotRow,
} from './catalog-reconcile-plan';
import { countMutations, edgeKey, planReconcile } from './catalog-reconcile-plan';
import { PERMISSION_CATALOG } from './permission.catalog';
import { ROLE_PERMISSION_CATALOG } from './role-permission.catalog';
import { ROLE_CATALOG } from './role.catalog';
import type { PermissionSeedDefinition, RoleSeedDefinition } from './seed-definitions';

/**
 * Converges the three catalog tables to a manifest (#235).
 *
 * The seed used to overwrite every `Permission` on every run and only ever add
 * `RolePermission` rows, so an operator's edit did not survive a deploy and a
 * grant dropped from the catalog stayed in the database (#232, defects 1 and 2).
 * This module replaces that with plan-then-apply over `managedBy` provenance:
 * `planReconcile` decides every write from data, `applyReconcilePlan` performs
 * exactly those writes, and `reconcileCatalog` runs both in one transaction so
 * a conflict or a failed statement leaves the tables as it found them.
 *
 * What it does NOT do, by design: take the boot lock (N instances booting at
 * once is #236's boot sequence, which wraps this call; the lock it does take,
 * first in its transaction, is the one the Owner's edits of the permission
 * catalog hold, `lockCatalogEdits`, #772), evict caches itself
 * (it has no Redis; it hands the applied plan to an optional port and the
 * caller decides — the standalone seed passes nothing), or accept a manifest
 * from anywhere but its caller (the catalog exports are the only production
 * manifest, so CI's checks on them are a complete gate for what gets written).
 *
 * The Owner's entries (`Admin` rows) are never converged, but every start
 * checks them again (#772): `findFailingEditedEntries` runs the entry check
 * over each one that still confers something, and the plan retires a failing
 * permission or revokes a failing grant, leaving the edit as it is for the
 * Owner to fix and hand back. A grant the server ships that the Owner's edits
 * make fail is withheld: this start does not give it. The server starts; the
 * entry fails closed.
 *
 * The pieces are exported separately because `npm run db:plan` wants a
 * plan-only mode (#236): `loadCatalogSnapshot` + `findFailingEditedEntries` +
 * `planReconcile` + the `describe*` helpers report what a reconcile WOULD do
 * without `applyReconcilePlan`.
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
 * How long the reconcile's transaction may stay open. The writes are a
 * handful of statements (on a first run, three `createMany`, two id lookups
 * and the snapshot reads), but the entry check runs inside the transaction
 * too: three statements for every permission the Owner edited, its probe's
 * count between a savepoint and its release (#772). So this is headroom for
 * a slow database and for an Owner who edited many permissions. `npm run
 * db:plan` runs the same probes in a transaction of its own and is given the
 * same budget, so the plan does not time out where the boot would not.
 */
export const RECONCILE_TRANSACTION_TIMEOUT_MS = 30_000;

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
      // First, before the snapshot: the lock the Owner's edits hold (#772),
      // so an edit is either in the snapshot, and judged by the entry check
      // below, or waits for this commit and is checked against what it wrote.
      await lockCatalogEdits(tx);

      const snapshot = await loadCatalogSnapshot(tx);
      // Inside the transaction: the probe needs one for its savepoint, and the
      // entries it judges are the ones the plan then writes.
      const failing = await findFailingEditedEntries(tx, manifest, snapshot);
      const planned = planReconcile(manifest, snapshot, failing);
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
    select: {
      managedBy: true,
      revokedAt: true,
      role: { select: { name: true } },
      permission: { select: { slug: true } },
    },
  });

  return {
    permissions,
    roles,
    rolePermissions: edges.map((edge) => ({
      roleName: edge.role.name,
      permissionSlug: edge.permission.slug,
      managedBy: edge.managedBy,
      revokedAt: edge.revokedAt,
    })),
  };
}

/**
 * The Owner's entries that fail the entry check at this start (#772), with
 * why, and the grants this start would give that the Owner's entries make
 * fail. A newer version of the server can make an edit that once passed fail:
 * a column it names renamed, a guard added, a grant given to another role.
 *
 * Judged, in this order:
 *
 * 1. Every grant the permission catalog ships that this start would create or
 *    restore. One the guards find a problem for, on its own role, is withheld:
 *    not given at this start, and judged again at the next. The shipped
 *    catalog passes the guards, so such a problem comes from the Owner's
 *    edits: a condition the Owner changed, or a revoked `User` grant that had
 *    exempted the role. Judged first, so a newer version giving an edited
 *    permission to one more role withholds that grant, rather than retiring
 *    the permission for every role that already holds it.
 * 2. Every `Admin` permission not yet retired, on Prisma's verdict on its
 *    condition (`probeConditions`) and on what the guards find for it, on
 *    every holder. A grant withheld in step 1 is not a holder.
 * 3. Every `Admin` grant not yet revoked, and every grant step 1 let through,
 *    on what the guards find for it, judged without the grants this start
 *    revokes or withholds: one taken away can be what exempted another. A
 *    grant on a permission this start retires is not judged: the permission
 *    confers nothing through it, and the permission is the edit to fix.
 *
 * An `Admin` entry already retired or revoked confers nothing, so it is never
 * judged again and a second start writes nothing for it. A withheld grant is
 * not a write, so a second start that withholds it again writes nothing
 * either.
 *
 * The guards compare the catalog as the server ships it with the catalog as
 * this start leaves it, which may differ from the tables as they stand: see
 * {@link catalogAfterReconcile}. Only what differs from the shipped catalog is
 * held against an entry. Warnings are not: at start only a problem fails one.
 *
 * `tx` must be an interactive transaction's client (the probe's savepoint).
 * It is asked nothing when the Owner has edited nothing.
 */
export async function findFailingEditedEntries(
  tx: Prisma.TransactionClient,
  manifest: CatalogManifest,
  snapshot: CatalogSnapshot,
): Promise<FailingEntries> {
  const permissions = new Map<string, readonly EntryProblem[]>();
  const grants = new Map<string, readonly EntryProblem[]>();
  const withheld = new Map<string, readonly EntryProblem[]>();
  const failing: FailingEntries = { permissions, grants, withheld };

  // Any row the Owner edited, live or not: a revoked `User` grant confers
  // nothing, but can still make a grant this start gives fail open.
  const edited = ({ managedBy }: { readonly managedBy: PermissionOwner }) => managedBy === PermissionOwner.Admin;
  if (!snapshot.permissions.some(edited) && !snapshot.rolePermissions.some(edited)) {
    return failing;
  }

  const editedPermissions = snapshot.permissions.filter((row) => edited(row) && row.retiredAt === null);
  const editedGrants = snapshot.rolePermissions.filter((edge) => edited(edge) && edge.revokedAt === null);

  // The shipped catalog's findings never change during a start, so the
  // guards run over it once.
  const shippedFindings = catalogFindings(catalogViewFromManifest(manifest));
  const after = catalogAfterReconcile(manifest, snapshot);
  const shipped = grantsArriving(manifest, snapshot);

  // 1. The grants this start gives.
  let left = settleGrants(shippedFindings, after, shipped, grants, withheld);

  // 2. The Owner's permissions, on every holder this start leaves them.
  if (editedPermissions.length > 0) {
    const view = catalogViewFromSnapshot(left);
    const found = newEntryFindings(
      shippedFindings,
      catalogFindings(view),
      editedPermissions.map(({ slug }) => ({ slug })),
    ).problems;
    const definitions = new Map(view.permissions.map((entry) => [entry.slug, entry]));

    for (const { slug } of editedPermissions) {
      // One probe at a time: its savepoint name is fixed.
      const probed = await probeConditions(tx, requireDefined(definitions.get(slug), 'permission', slug));
      const problems = [...probed, ...found.filter((problem) => problem.slug === slug)];
      if (problems.length > 0) {
        permissions.set(slug, problems);
      }
    }
  }

  // A permission retired here confers nothing through any grant, so a grant
  // of it withheld in step 1 is given after all: the permission is what the
  // Owner fixes, and giving the grant back with it is the next start's to
  // judge.
  for (const { roleName, slug } of shipped) {
    if (permissions.has(slug)) {
      withheld.delete(edgeKey(roleName, slug));
    }
  }

  left = {
    ...left,
    permissions: left.permissions.filter(({ slug }) => !permissions.has(slug)),
  };
  const live = new Set(catalogViewFromSnapshot(left).permissions.map(({ slug }) => slug));
  const standing = shipped.filter(({ roleName, slug }) => !withheld.has(edgeKey(roleName, slug)));

  // 3. The Owner's grants, with the grants step 1 let through: taking one of
  // the Owner's away can make a grant this start gives fail.
  settleGrants(
    shippedFindings,
    left,
    [
      ...editedGrants.map(({ roleName, permissionSlug }): GrantTarget => ({ roleName, slug: permissionSlug })),
      ...standing,
    ].filter(({ slug }) => live.has(slug)),
    grants,
    withheld,
  );

  return failing;
}

/** A grant judged at a start: one the Owner edited, or one the permission catalog ships (`shipped`). */
interface GrantTarget {
  readonly roleName: string;
  readonly slug: string;
  readonly shipped?: true;
}

/**
 * Judges `targets` to a fixed point, starting from `snapshot`, and records
 * each one that fails: an `Admin` grant in `grants`, to revoke, a shipped one
 * in `withheld`, to leave out. Returns the snapshot without the grants it
 * failed.
 *
 * A grant taken away can be what kept another passing: `User` holding a slug
 * exempts every other holder from the unconditioned-grant guards. So the
 * grants a pass fails leave the view, the rest are judged again, and the
 * passes stop at one that fails nothing. Every pass before it fails a grant,
 * so there are never more passes than targets. Each pass runs the guards once,
 * over the whole view, and picks each target's findings from that run.
 *
 * An `Admin` grant on `User` is judged as its permission, on every holder,
 * as when it is edited. A shipped grant is held only to the problems on its
 * own role: whatever else is wrong with its permission is the permission's,
 * and judged there.
 */
function settleGrants(
  shippedFindings: CatalogFindings,
  snapshot: CatalogSnapshot,
  targets: readonly GrantTarget[],
  grants: Map<string, readonly EntryProblem[]>,
  withheld: Map<string, readonly EntryProblem[]>,
): CatalogSnapshot {
  let left = snapshot;
  let pending = targets;

  while (pending.length > 0) {
    const now = catalogFindings(catalogViewFromSnapshot(left));
    const failed = new Set<string>();

    for (const target of pending) {
      const found = newEntryFindings(shippedFindings, now, [target]).problems;
      const problems = target.shipped ? found.filter((problem) => roleOf(problem) === target.roleName) : found;
      if (problems.length > 0) {
        const key = edgeKey(target.roleName, target.slug);
        (target.shipped ? withheld : grants).set(key, problems);
        failed.add(key);
      }
    }

    if (failed.size === 0) {
      break;
    }

    left = {
      ...left,
      rolePermissions: left.rolePermissions.filter((edge) => !failed.has(edgeKey(edge.roleName, edge.permissionSlug))),
    };
    pending = pending.filter(({ roleName, slug }) => !failed.has(edgeKey(roleName, slug)));
  }

  return left;
}

function roleOf(problem: EntryProblem): string | undefined {
  return 'role' in problem ? problem.role : undefined;
}

/**
 * The grants the permission catalog ships that this start gives, as the
 * planner decides them: one with no row, created, and a `System` one revoked,
 * restored. A grant of a role `ROLE_SCOPE` does not classify is left out, as
 * the view leaves it out.
 */
function grantsArriving(manifest: CatalogManifest, snapshot: CatalogSnapshot): GrantTarget[] {
  const edgesByKey = new Map(
    snapshot.rolePermissions.map((edge) => [edgeKey(edge.roleName, edge.permissionSlug), edge]),
  );
  const arriving: GrantTarget[] = [];

  for (const [roleName, slugs] of Object.entries(manifest.rolePermissions)) {
    for (const slug of slugs) {
      const edge = edgesByKey.get(edgeKey(roleName, slug));
      if (edge === undefined || (edge.managedBy === PermissionOwner.System && edge.revokedAt !== null)) {
        arriving.push({ roleName, slug, shipped: true });
      }
    }
  }

  return arriving;
}

/**
 * The three tables as this start leaves them, before the entry check retires
 * or revokes anything (#772): every row the server owns as the permission
 * catalog ships it (created, converged, revived; retired or removed when the
 * catalog dropped it), and every other row as the database holds it, the
 * planner's rule for who owns what.
 *
 * The check judges the Owner's entries against this rather than the tables as
 * they stand, because a newer version can give an edited permission to
 * another role in this same start. Judged against the grants already in the
 * database, a permission the Owner made unconditioned would pass, and the
 * start would then give it to a household role across every household.
 */
function catalogAfterReconcile(manifest: CatalogManifest, snapshot: CatalogSnapshot): CatalogSnapshot {
  const leftAsIs = (row: { readonly managedBy: PermissionOwner }) => row.managedBy !== PermissionOwner.System;

  const rowsBySlug = new Map(snapshot.permissions.map((row) => [row.slug, row]));
  const listedSlugs = new Set(manifest.permissions.map(({ slug }) => slug));
  const permissions: PermissionSnapshotRow[] = [
    ...manifest.permissions.map((wanted) => {
      const row = rowsBySlug.get(wanted.slug);
      return row !== undefined && leftAsIs(row) ? row : shippedRow(wanted);
    }),
    ...snapshot.permissions.filter((row) => !listedSlugs.has(row.slug) && leftAsIs(row)),
  ];

  const edgesByKey = new Map(
    snapshot.rolePermissions.map((edge) => [edgeKey(edge.roleName, edge.permissionSlug), edge]),
  );
  const listedEdges = new Set<string>();
  const rolePermissions: RolePermissionSnapshotRow[] = [];
  for (const [roleName, slugs] of Object.entries(manifest.rolePermissions)) {
    for (const permissionSlug of slugs) {
      const key = edgeKey(roleName, permissionSlug);
      const edge = edgesByKey.get(key);
      listedEdges.add(key);
      rolePermissions.push(
        edge !== undefined && leftAsIs(edge)
          ? edge
          : { roleName, permissionSlug, managedBy: PermissionOwner.System, revokedAt: null },
      );
    }
  }
  rolePermissions.push(
    ...snapshot.rolePermissions.filter(
      (edge) => !listedEdges.has(edgeKey(edge.roleName, edge.permissionSlug)) && leftAsIs(edge),
    ),
  );

  return { permissions, roles: snapshot.roles, rolePermissions };
}

/** A permission catalog entry as a converged `System` row; an absent condition stays absent. */
function shippedRow(wanted: PermissionSeedDefinition): PermissionSnapshotRow {
  return {
    slug: wanted.slug,
    action: wanted.action,
    subject: wanted.subject,
    fields: [...(wanted.fields ?? [])],
    conditions: (wanted.conditions ?? null) as Prisma.JsonValue,
    inverted: false,
    reason: wanted.reason,
    riskLevel: wanted.riskLevel,
    managedBy: PermissionOwner.System,
    retiredAt: null,
  };
}

/**
 * Performs the plan's writes and nothing else, in dependency order:
 * permissions, then roles, then the edges between them (deletes, then
 * restores, then the entry check's revokes, then creates). Every write on an
 * existing row is guarded by `managedBy: System`, so a row whose ownership
 * changed between the snapshot and the write is never clobbered. The entry
 * check's retire and revoke (#772) are the exception, the only writes to the
 * Owner's rows: each is guarded by `managedBy: Admin` and by the row still
 * conferring something, and writes only the time, so an edit handed back or
 * already failed closed under the plan is never touched, and the edit itself
 * never is. An edit the Owner changed under the plan and kept `Admin` still
 * passes that guard, and is retired or revoked on the verdict the snapshot
 * earned: a race that fails closed, never open. A single-row `update` that
 * finds no row throws on its own.
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

  // No `limit`: with it Prisma moves the `where` into a subquery, and the
  // guard is not checked again on the row it writes.
  if (plan.permissions.retireEdited.length > 0) {
    const { count } = await tx.permission.updateMany({
      where: {
        slug: { in: plan.permissions.retireEdited.map(({ slug }) => slug) },
        managedBy: PermissionOwner.Admin,
        retiredAt: null,
      },
      data: { retiredAt: now },
    });
    assertWrote('permission.updateMany (entry check)', count, plan.permissions.retireEdited.length);
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

  const edges = [
    ...plan.rolePermissions.delete,
    ...plan.rolePermissions.restore,
    ...plan.rolePermissions.revokeEdited,
    ...plan.rolePermissions.create,
  ];
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

  if (plan.rolePermissions.restore.length > 0) {
    const { count } = await tx.rolePermission.updateMany({
      where: {
        managedBy: PermissionOwner.System,
        revokedAt: { not: null },
        OR: plan.rolePermissions.restore.map(resolve),
      },
      data: { revokedAt: null },
    });
    assertWrote('rolePermission.updateMany', count, plan.rolePermissions.restore.length);
  }

  if (plan.rolePermissions.revokeEdited.length > 0) {
    const { count } = await tx.rolePermission.updateMany({
      where: {
        managedBy: PermissionOwner.Admin,
        revokedAt: null,
        OR: plan.rolePermissions.revokeEdited.map(resolve),
      },
      data: { revokedAt: now },
    });
    assertWrote('rolePermission.updateMany (entry check)', count, plan.rolePermissions.revokeEdited.length);
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

/**
 * One line: what the apply wrote, by table, then the Owner's entries the entry
 * check failed and the shipped grants it withheld (#772).
 */
export function summarizePlan(plan: ReconcilePlan): string {
  const { permissions, roles, rolePermissions } = plan;
  return (
    `Catalog reconcile: permissions +${permissions.create.length} ~${permissions.update.length} ` +
    `revived ${permissions.revive.length} retired ${permissions.retire.length}; ` +
    `roles +${roles.create.length} ~${roles.update.length}; ` +
    `grants +${rolePermissions.create.length} -${rolePermissions.delete.length} ` +
    `restored ${rolePermissions.restore.length}; ` +
    `edits failing the entry check: retired ${permissions.retireEdited.length}, ` +
    `revoked ${rolePermissions.revokeEdited.length}; ` +
    `shipped grants withheld ${rolePermissions.withheld.length}`
  );
}

/**
 * Every write that changes or removes authority, one line each: updated
 * permissions and roles with their field changes, revived and retired slugs,
 * removed and restored grants, and the Owner's entries the entry check
 * retired or revoked, with every problem in full (#772). Creates only add and
 * stay counted by the summary — the first run would otherwise print one line
 * per catalog entry.
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
  for (const { slug, problems } of plan.permissions.retireEdited) {
    lines.push(`permission '${slug}' retired after its check: ${formatProblems(problems)}`);
  }
  for (const { name, changes } of plan.roles.update) {
    lines.push(`role '${name}' updated: ${formatChanges(changes)}`);
  }
  for (const { roleName, permissionSlug } of plan.rolePermissions.delete) {
    lines.push(`grant '${roleName} → ${permissionSlug}' removed`);
  }
  for (const { roleName, permissionSlug } of plan.rolePermissions.restore) {
    lines.push(`grant '${roleName} → ${permissionSlug}' restored`);
  }
  for (const { roleName, permissionSlug, problems } of plan.rolePermissions.revokeEdited) {
    lines.push(`grant '${roleName} → ${permissionSlug}' revoked after its check: ${formatProblems(problems)}`);
  }

  return lines;
}

/**
 * The drift report: every row the reconciler saw and left alone, with why.
 * This is the answer to "which permissions have operators modified?". An
 * Owner's entry the entry check failed leads its table, naming each kind of
 * problem once: the entry stops conferring anything, and its edit is kept as
 * it is to fix and hand back (#772). The write lines carry each problem in full.
 * A shipped grant the entry check withheld is not a write, so its line here
 * carries its problems in full: the grant is not given until the Owner's
 * edits stop making it fail.
 *
 * A row left alone that confers nothing, retired before this start or by it,
 * or a grant revoked, is marked `(retired)` or `(revoked)`, so the line a
 * later start logs for an edit the entry check failed never reads as live.
 */
export function describeDrift(plan: ReconcilePlan): string[] {
  const lines: string[] = [];
  const retiredNow = new Set(plan.permissions.retireEdited.map(({ slug }) => slug));
  const revokedNow = new Set(
    plan.rolePermissions.revokeEdited.map(({ roleName, permissionSlug }) => edgeKey(roleName, permissionSlug)),
  );
  const mark = (state: string, applies: boolean): string => (applies ? ` (${state})` : '');

  for (const { slug, problems } of plan.permissions.retireEdited) {
    lines.push(
      `${PermissionOwner.Admin}-owned permission '${slug}' fails the entry check (${problemKinds(problems)}): ` +
        'retired, the edit kept',
    );
  }
  for (const { slug, managedBy, drift } of plan.permissions.skipped) {
    const retired = retiredNow.has(slug) || drift.some(({ field }) => field === 'retiredAt');
    lines.push(
      `${managedBy}-owned permission '${slug}'${mark('retired', retired)} left alone${describeChanges(drift)}`,
    );
  }
  for (const { slug, managedBy, retiredAt } of plan.permissions.retained) {
    const retired = retiredNow.has(slug) || retiredAt !== null;
    lines.push(`${managedBy}-owned permission '${slug}'${mark('retired', retired)} is not in the manifest; retained`);
  }
  for (const { name, managedBy, drift } of plan.roles.skipped) {
    lines.push(`${managedBy}-owned role '${name}' left alone${describeChanges(drift)}`);
  }
  for (const name of plan.roles.orphans) {
    // The row is kept — that is what "never mutated" covers; its System grants
    // follow the RolePermission rule and are removed with the rest.
    const removed = plan.rolePermissions.delete.filter((edge) => edge.roleName === name).length;
    lines.push(
      `System-owned role '${name}' is not in the manifest; the row is kept, ${removed} of its System grants ` +
        `${removed === 1 ? 'is' : 'are'} removed`,
    );
  }
  for (const { roleName, permissionSlug, problems } of plan.rolePermissions.revokeEdited) {
    lines.push(
      `${PermissionOwner.Admin}-owned grant '${roleName} → ${permissionSlug}' fails the entry check ` +
        `(${problemKinds(problems)}): revoked, the row kept`,
    );
  }
  for (const { roleName, permissionSlug, problems } of plan.rolePermissions.withheld) {
    lines.push(
      `System grant '${roleName} → ${permissionSlug}' fails the entry check against the Owner's edits: ` +
        `not given, and judged again at the next start: ${formatProblems(problems)}`,
    );
  }
  for (const { roleName, permissionSlug } of plan.rolePermissions.skipped) {
    lines.push(`grant '${roleName} → ${permissionSlug}' was revoked on this server`);
  }
  for (const { roleName, permissionSlug, managedBy, revokedAt } of plan.rolePermissions.retained) {
    const revoked = revokedNow.has(edgeKey(roleName, permissionSlug)) || revokedAt !== null;
    lines.push(
      `${managedBy}-owned grant '${roleName} → ${permissionSlug}'${mark('revoked', revoked)} is not in the manifest; ` +
        'retained',
    );
  }

  return lines;
}

function describeChanges(changes: readonly FieldChange[]): string {
  return changes.length === 0 ? '; no drift' : `; drift: ${formatChanges(changes)}`;
}

/** Each kind of problem once, in order of first appearance. */
function problemKinds(problems: readonly EntryProblem[]): string {
  return [...new Set(problems.map(({ kind }) => kind))].join(', ');
}

/** Every problem in full: its kind, then what it says beyond the slug the line already names. */
function formatProblems(problems: readonly EntryProblem[]): string {
  return problems
    .map((problem) => {
      const detail = Object.fromEntries(Object.entries(problem).filter(([key]) => key !== 'kind' && key !== 'slug'));
      return `${problem.kind} ${JSON.stringify(detail)}`;
    })
    .join('; ');
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
