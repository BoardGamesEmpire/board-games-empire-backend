import type { Action, Prisma, RiskLevel } from '../client';
import { PermissionOwner } from '../client';
import type { PermissionSeedDefinition, RoleSeedDefinition } from './seed-definitions';

/**
 * The desired state of the three catalog tables — what the database should
 * hold once this code version has reconciled it (#235). The shipped one is
 * `CATALOG_MANIFEST`; the reconciler takes it as a parameter so a test can hand
 * it a modified copy and the production caller stays the only one that passes
 * the catalog exports.
 */
export interface CatalogManifest {
  readonly permissions: readonly PermissionSeedDefinition[];
  readonly roles: readonly RoleSeedDefinition[];
  /** Role name → slugs the role holds. */
  readonly rolePermissions: Readonly<Record<string, readonly string[]>>;
}

/** The columns of a `Permission` row the planner compares or reads. */
export interface PermissionSnapshotRow {
  readonly slug: string;
  readonly action: Action;
  readonly subject: string;
  readonly fields: readonly string[];
  readonly conditions: Prisma.JsonValue | null;
  readonly inverted: boolean;
  readonly reason: string | null;
  readonly riskLevel: RiskLevel;
  readonly managedBy: PermissionOwner;
  readonly retiredAt: Date | null;
}

export interface RoleSnapshotRow {
  readonly name: string;
  readonly description: string | null;
  readonly managedBy: PermissionOwner;
}

/** A `RolePermission` row by the names the manifest speaks in, not by id. */
export interface RolePermissionSnapshotRow {
  readonly roleName: string;
  readonly permissionSlug: string;
  readonly managedBy: PermissionOwner;
}

/** The current state of the three catalog tables, as `loadCatalogSnapshot` reads it. */
export interface CatalogSnapshot {
  readonly permissions: readonly PermissionSnapshotRow[];
  readonly roles: readonly RoleSnapshotRow[];
  readonly rolePermissions: readonly RolePermissionSnapshotRow[];
}

/**
 * The `Permission` columns the manifest owns and the reconciler converges.
 * `inverted` is among them although no catalog entry carries it: the catalog
 * declares `can` rules only (every seeded role rule is a grant, which the e2e
 * role-model invariants pin), so its manifest value is `false` for every row.
 */
export type PermissionField = 'action' | 'subject' | 'fields' | 'conditions' | 'inverted' | 'reason' | 'riskLevel';

/** One column that differs: the database value and the manifest value. */
export interface FieldChange<Field extends string = string> {
  readonly field: Field;
  readonly from: unknown;
  readonly to: unknown;
}

/** A `System` permission that drifted from the manifest, and how. */
export interface PermissionUpdate {
  readonly slug: string;
  readonly changes: readonly FieldChange<PermissionField>[];
}

/**
 * A permission the manifest lists but the reconciler does not own; `drift` is
 * the report. It includes `retiredAt` when the row is tombstoned: only a
 * `System` row is revived, so an operator-owned tombstone stays one, and the
 * report must say so.
 */
export interface PermissionSkip {
  readonly slug: string;
  readonly managedBy: PermissionOwner;
  readonly drift: readonly FieldChange<PermissionField | 'retiredAt'>[];
}

/** A permission the manifest does not list and the reconciler does not own. */
export interface RetainedPermission {
  readonly slug: string;
  readonly managedBy: PermissionOwner;
}

export interface RoleUpdate {
  readonly name: string;
  readonly changes: readonly FieldChange<'description'>[];
}

export interface RoleSkip {
  readonly name: string;
  readonly managedBy: PermissionOwner;
  readonly drift: readonly FieldChange<'description'>[];
}

export interface RolePermissionEdge {
  readonly roleName: string;
  readonly permissionSlug: string;
}

/**
 * What a reconcile would do, decided before anything is written. Mutations
 * are `create`, `update`, `revive`, `retire` and `delete`; the rest is the
 * drift report — rows the reconciler saw and deliberately left alone. A
 * non-empty `conflicts` anywhere stops the apply before its first write.
 */
export interface ReconcilePlan {
  readonly permissions: {
    /** Manifest has it, database lacks it → written as `System`. */
    readonly create: readonly PermissionSeedDefinition[];
    /** `System` row that drifted from the manifest → converged, field by field. */
    readonly update: readonly PermissionUpdate[];
    /** Retired `System` row whose slug is back → `retiredAt` cleared (may also appear in `update`). */
    readonly revive: readonly string[];
    /** `System` row the manifest no longer lists and not yet retired → tombstoned. */
    readonly retire: readonly string[];
    /** `Admin` row the manifest lists → left alone; its drift is the report. */
    readonly skipped: readonly PermissionSkip[];
    /** Row the manifest does not list and the reconciler does not own → left alone. */
    readonly retained: readonly RetainedPermission[];
    /** `Plugin` row whose slug the manifest claims → the apply refuses to run. */
    readonly conflicts: readonly { readonly slug: string }[];
  };
  readonly roles: {
    readonly create: readonly RoleSeedDefinition[];
    readonly update: readonly RoleUpdate[];
    readonly skipped: readonly RoleSkip[];
    /** `System` role the manifest no longer lists → reported, never mutated. */
    readonly orphans: readonly string[];
    readonly conflicts: readonly { readonly name: string }[];
  };
  readonly rolePermissions: {
    readonly create: readonly RolePermissionEdge[];
    /** `System` edge the manifest no longer lists → deleted; this is how a grant is revoked. */
    readonly delete: readonly RolePermissionEdge[];
    /** Edge the manifest does not list and the reconciler does not own → left alone. */
    readonly retained: readonly RolePermissionSnapshotRow[];
    readonly conflicts: readonly RolePermissionEdge[];
  };
}

const PERMISSION_FIELDS: readonly PermissionField[] = [
  'action',
  'subject',
  'fields',
  'conditions',
  'inverted',
  'reason',
  'riskLevel',
];

/**
 * Decides what the database needs to match the manifest, without touching it.
 * Pure: every input is data, so every row of the reconcile table is a unit test.
 */
export function planReconcile(manifest: CatalogManifest, snapshot: CatalogSnapshot): ReconcilePlan {
  return {
    permissions: planPermissions(manifest, snapshot),
    roles: planRoles(manifest, snapshot),
    rolePermissions: planRolePermissions(manifest, snapshot),
  };
}

/**
 * How many rows an apply of this plan writes. A permission that is both
 * revived and drifted is one write, so `update` and `revive` count as their
 * union. The drift report (`skipped`, `retained`, `orphans`) and `conflicts`
 * are not writes, so a second reconcile over an unchanged catalog counts zero
 * — the idempotency the seed relies on and the check #236's hash
 * short-circuit can be measured against.
 */
export function countMutations(plan: ReconcilePlan): number {
  const converged = new Set([...plan.permissions.update.map(({ slug }) => slug), ...plan.permissions.revive]);

  return (
    plan.permissions.create.length +
    converged.size +
    plan.permissions.retire.length +
    plan.roles.create.length +
    plan.roles.update.length +
    plan.rolePermissions.create.length +
    plan.rolePermissions.delete.length
  );
}

/**
 * The writes by table, as the boot summary reports them (#236). The
 * per-table numbers are the ones `summarizePlan` prints, so a permission that
 * is revived and drifted appears in both `permissionsUpdated` and
 * `permissionsRevived`; `mutations` is {@link countMutations}, which counts
 * it once. Every field is zero on a converged database.
 */
export interface ReconcileCounts {
  readonly permissionsCreated: number;
  readonly permissionsUpdated: number;
  readonly permissionsRevived: number;
  readonly permissionsRetired: number;
  readonly rolesCreated: number;
  readonly rolesUpdated: number;
  readonly grantsCreated: number;
  readonly grantsRevoked: number;
  readonly mutations: number;
}

export function reconcileCounts(plan: ReconcilePlan): ReconcileCounts {
  return {
    permissionsCreated: plan.permissions.create.length,
    permissionsUpdated: plan.permissions.update.length,
    permissionsRevived: plan.permissions.revive.length,
    permissionsRetired: plan.permissions.retire.length,
    rolesCreated: plan.roles.create.length,
    rolesUpdated: plan.roles.update.length,
    grantsCreated: plan.rolePermissions.create.length,
    grantsRevoked: plan.rolePermissions.delete.length,
    mutations: countMutations(plan),
  };
}

function planPermissions(manifest: CatalogManifest, snapshot: CatalogSnapshot): ReconcilePlan['permissions'] {
  const create: PermissionSeedDefinition[] = [];
  const update: PermissionUpdate[] = [];
  const revive: string[] = [];
  const retire: string[] = [];
  const skipped: PermissionSkip[] = [];
  const retained: RetainedPermission[] = [];
  const conflicts: { slug: string }[] = [];

  const rowsBySlug = new Map(snapshot.permissions.map((row) => [row.slug, row]));

  for (const wanted of manifest.permissions) {
    const row = rowsBySlug.get(wanted.slug);

    if (row === undefined) {
      create.push(wanted);
      continue;
    }

    switch (row.managedBy) {
      case PermissionOwner.System: {
        const changes = diffPermission(wanted, row);
        if (changes.length > 0) {
          update.push({ slug: wanted.slug, changes });
        }
        if (row.retiredAt !== null) {
          revive.push(wanted.slug);
        }
        break;
      }
      case PermissionOwner.Admin: {
        const drift: FieldChange<PermissionField | 'retiredAt'>[] = diffPermission(wanted, row);
        if (row.retiredAt !== null) {
          drift.push({ field: 'retiredAt', from: row.retiredAt, to: null });
        }
        skipped.push({ slug: wanted.slug, managedBy: row.managedBy, drift });
        break;
      }
      case PermissionOwner.Plugin:
        conflicts.push({ slug: wanted.slug });
        break;
      default:
        assertNever(row.managedBy);
    }
  }

  const listed = new Set(manifest.permissions.map(({ slug }) => slug));

  for (const row of snapshot.permissions) {
    if (listed.has(row.slug)) {
      continue;
    }

    if (row.managedBy !== PermissionOwner.System) {
      retained.push({ slug: row.slug, managedBy: row.managedBy });
    } else if (row.retiredAt === null) {
      retire.push(row.slug);
    }
  }

  return { create, update, revive, retire, skipped, retained, conflicts };
}

function planRoles(manifest: CatalogManifest, snapshot: CatalogSnapshot): ReconcilePlan['roles'] {
  const create: RoleSeedDefinition[] = [];
  const update: RoleUpdate[] = [];
  const skipped: RoleSkip[] = [];
  const orphans: string[] = [];
  const conflicts: { name: string }[] = [];

  const rowsByName = new Map(snapshot.roles.map((row) => [row.name, row]));

  for (const wanted of manifest.roles) {
    const row = rowsByName.get(wanted.name);

    if (row === undefined) {
      create.push(wanted);
      continue;
    }

    const drift: FieldChange<'description'>[] =
      row.description === wanted.description
        ? []
        : [{ field: 'description', from: row.description, to: wanted.description }];

    switch (row.managedBy) {
      case PermissionOwner.System:
        if (drift.length > 0) {
          update.push({ name: wanted.name, changes: drift });
        }
        break;
      case PermissionOwner.Admin:
        skipped.push({ name: wanted.name, managedBy: row.managedBy, drift });
        break;
      case PermissionOwner.Plugin:
        conflicts.push({ name: wanted.name });
        break;
      default:
        assertNever(row.managedBy);
    }
  }

  const listed = new Set<string>(manifest.roles.map(({ name }) => name));

  for (const row of snapshot.roles) {
    if (!listed.has(row.name) && row.managedBy === PermissionOwner.System) {
      orphans.push(row.name);
    }
  }

  return { create, update, skipped, orphans, conflicts };
}

function planRolePermissions(manifest: CatalogManifest, snapshot: CatalogSnapshot): ReconcilePlan['rolePermissions'] {
  const create: RolePermissionEdge[] = [];
  const remove: RolePermissionEdge[] = [];
  const retained: RolePermissionSnapshotRow[] = [];
  const conflicts: RolePermissionEdge[] = [];

  const rowsByKey = new Map(snapshot.rolePermissions.map((row) => [edgeKey(row.roleName, row.permissionSlug), row]));
  const listed = new Set<string>();

  for (const [roleName, slugs] of Object.entries(manifest.rolePermissions)) {
    for (const permissionSlug of slugs) {
      const key = edgeKey(roleName, permissionSlug);
      listed.add(key);
      const row = rowsByKey.get(key);

      if (row === undefined) {
        create.push({ roleName, permissionSlug });
        continue;
      }

      switch (row.managedBy) {
        case PermissionOwner.System:
        case PermissionOwner.Admin:
          // The pair IS the row: an edge that exists has nothing to converge.
          break;
        case PermissionOwner.Plugin:
          conflicts.push({ roleName, permissionSlug });
          break;
        default:
          assertNever(row.managedBy);
      }
    }
  }

  for (const row of snapshot.rolePermissions) {
    if (listed.has(edgeKey(row.roleName, row.permissionSlug))) {
      continue;
    }

    switch (row.managedBy) {
      case PermissionOwner.System:
        remove.push({ roleName: row.roleName, permissionSlug: row.permissionSlug });
        break;
      case PermissionOwner.Admin:
      case PermissionOwner.Plugin:
        retained.push(row);
        break;
      default:
        assertNever(row.managedBy);
    }
  }

  return { create, delete: remove, retained, conflicts };
}

/** NUL as the separator: neither a role name nor a slug can contain it, so two pairs cannot share a key. */
function edgeKey(roleName: string, permissionSlug: string): string {
  return `${roleName}\u0000${permissionSlug}`;
}

/**
 * The columns of `wanted` that `row` does not match, in catalog-column order.
 * `fields` compares as a set — the write side keeps catalog order, so a reorder
 * is not a change — and `conditions` compares as canonical JSON with an absent
 * member equal to `{}`, which is what the column has always held for it.
 */
function diffPermission(wanted: PermissionSeedDefinition, row: PermissionSnapshotRow): FieldChange<PermissionField>[] {
  const changes: FieldChange<PermissionField>[] = [];

  for (const field of PERMISSION_FIELDS) {
    const [from, to, same] = comparePermissionField(field, wanted, row);
    if (!same) {
      changes.push({ field, from, to });
    }
  }

  return changes;
}

function comparePermissionField(
  field: PermissionField,
  wanted: PermissionSeedDefinition,
  row: PermissionSnapshotRow,
): [from: unknown, to: unknown, same: boolean] {
  switch (field) {
    case 'action':
      return [row.action, wanted.action, row.action === wanted.action];
    case 'subject':
      return [row.subject, wanted.subject, row.subject === wanted.subject];
    case 'riskLevel':
      return [row.riskLevel, wanted.riskLevel, row.riskLevel === wanted.riskLevel];
    case 'reason':
      return [row.reason, wanted.reason, row.reason === wanted.reason];
    case 'inverted':
      return [row.inverted, false, row.inverted === false];
    case 'fields': {
      const to = wanted.fields ?? [];
      return [row.fields, to, sameSet(row.fields, to)];
    }
    case 'conditions': {
      const to: Prisma.InputJsonObject = wanted.conditions ?? {};
      const from: Prisma.JsonValue = row.conditions ?? {};
      return [from, to, canonicalJson(from) === canonicalJson(to)];
    }
    default:
      return assertNever(field);
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/** `JSON.stringify` with object keys sorted at every depth; arrays keep their order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }

  return value;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled value ${String(value)}`);
}
