import {
  CATALOG_MANIFEST,
  catalogViewFromSnapshot,
  checkCatalogEntries,
  DatabaseService,
  loadCatalogSnapshot,
  PermissionOwner,
  planReconcile,
  PLUGIN_REQUESTED_PERMISSIONS_READER,
  probeConditions,
  RECONCILE_TRANSACTION_TIMEOUT_MS,
  type CatalogSnapshot,
  type CatalogView,
  type EntryProblem,
  type EntryWarning,
  type FieldChange,
  type PermissionSeedDefinition,
  type PermissionSnapshotRow,
  type PluginRequestedPermissionsReader,
  type Prisma,
} from '@bge/database';
import { t } from '@bge/i18n';
import { PermissionsService } from '@bge/permissions';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { isDeepStrictEqual } from 'node:util';
import { lockCatalogEdits } from './catalog-edit-lock';
import { countConsentDecisionsLost, loadConsentDecisionsInForce } from './consent-effect';
import {
  catalogPermission,
  type CatalogGrantDto,
  type CatalogRoleDto,
  type PermissionCatalogDto,
  type PermissionEditDto,
} from './dto/catalog.response';
import type { UpdatePermissionDto } from './dto/update-permission.dto';
import { PermissionUpdatedEvent, type PermissionSnapshot } from './events/permission-catalog.events';
import { refuseOwnerLockout } from './owner-control';

/** A permission row as the edit reads it: the planner's columns, and what guards the write. */
const PERMISSION_ROW_SELECT = {
  id: true,
  updatedAt: true,
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
} satisfies Prisma.PermissionSelect;

/**
 * How long an edit's transaction may stay open (#772). The wait for the edit
 * lock counts against it, and a start's reconcile holds that lock for up to
 * `RECONCILE_TRANSACTION_TIMEOUT_MS` while it probes every permission the
 * Owner edited. On Prisma's default of five seconds, an edit saved while
 * another instance starts would expire waiting (P2028) and answer 500. With
 * the reconcile's whole budget to wait, and as much again for its own check
 * and write, it waits its turn instead.
 */
export const CATALOG_EDIT_TRANSACTION_TIMEOUT_MS = 2 * RECONCILE_TRANSACTION_TIMEOUT_MS;

/** The properties of an edit that change something. */
const EDITABLE = [
  'conditions',
  'reason',
  'riskLevel',
  'retired',
] as const satisfies readonly (keyof UpdatePermissionDto)[];

/**
 * The Owner's reads and edits of the permission catalog (#772).
 *
 * Every edit first takes the permission catalog's edit lock (`lockCatalogEdits`), so edits
 * run one at a time and each one's check reads the permission catalog as the
 * last edit left it.
 *
 * An edit is checked before it is written, and refused with the problems the
 * check found: Prisma's verdict on the condition (`probeConditions`) and what
 * the catalog guards find that the permission catalog did not already have
 * (`checkCatalogEntries`). One that would leave the Owner without
 * `manage:all` is refused too (`refuseOwnerLockout`). Then it is written in
 * the same transaction, marked as managed by the Owner so bootstrap keeps it,
 * and guarded by the row as it was read, so an edit that raced a start's
 * reconcile answers 409 rather than overwriting it.
 *
 * After the commit every cached ability graph goes, since what a role confers
 * changed, and the edit is audited. An edit that changes nothing writes
 * nothing, and none of this happens.
 */
@Injectable()
export class PermissionCatalogService {
  private readonly logger = new Logger(PermissionCatalogService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly permissions: PermissionsService,
    private readonly eventEmitter: EventEmitter2,
    /**
     * The plugin runtime's reader of each plugin's active manifest, which the
     * plugin ability read bounds consent decisions by (#577). Optional as it is
     * there: in a process without the runtime no decision confers, so none
     * is counted.
     */
    @Optional()
    @Inject(PLUGIN_REQUESTED_PERMISSIONS_READER)
    private readonly requestedPermissionsReader?: PluginRequestedPermissionsReader,
  ) {}

  /**
   * Every permission and role, with how the ones the Owner edited differ from
   * the permission catalog this version ships: the drift a start reports and
   * leaves alone.
   */
  async getCatalog(): Promise<PermissionCatalogDto> {
    return catalogOf(await loadCatalogSnapshot(this.db));
  }

  /**
   * Edits one permission's condition, reason or risk level, or retires or
   * revives it (#772). See {@link checkEdit} for what is checked, and when.
   *
   * An edit whose result is the row as read, such as reviving a live
   * permission or sending the current reason again, answers the row as it is
   * and writes nothing: no mark that the Owner manages it, no flush, no event.
   */
  async updatePermission(slug: string, edit: UpdatePermissionDto): Promise<PermissionEditDto> {
    // A body that names nothing to change is the client's mistake, and it
    // hears so. One that names the current values is answered below as an
    // edit that changes nothing.
    if (!EDITABLE.some((key) => edit[key] !== undefined)) {
      throw new BadRequestException({
        code: 'CATALOG_EDIT_EMPTY',
        message: t('errors.permission_catalog.edit_empty'),
      });
    }

    const initiatedAt = new Date();

    const edited = await this.underEditLock(async (tx) => {
      const row = await tx.permission.findUnique({ where: { slug }, select: PERMISSION_ROW_SELECT });
      if (row === null) {
        throw new NotFoundException({
          code: 'CATALOG_ENTRY_NOT_FOUND',
          message: t('errors.permission_catalog.entry_not_found', { slug }),
        });
      }

      // A plugin's permission belongs to its plugin, which keeps it in line
      // with its manifest; the Owner's edit would take it from the plugin.
      if (row.managedBy === PermissionOwner.Plugin) {
        throw new ConflictException({
          code: 'CATALOG_ENTRY_NOT_EDITABLE',
          message: t('errors.permission_catalog.entry_not_editable', { slug }),
        });
      }

      const { id, updatedAt, ...before } = row;
      const after = applyEdit(before, edit, initiatedAt);
      const snapshot = await loadCatalogSnapshot(tx);

      if (sameEntry(before, after)) {
        return {
          changed: false as const,
          permission: catalogPermission(before, catalogDrift(snapshot).permissions.get(slug) ?? []),
        };
      }

      const catalog = withPermissionRow(snapshot, after);
      refuseOwnerLockout(catalog);

      const { problems, warnings } = await checkEdit(tx, snapshot, catalog, after, edit.conditions !== undefined);

      if (problems.length > 0) {
        throw new UnprocessableEntityException({
          code: 'CATALOG_ENTRY_REFUSED',
          message: t('errors.permission_catalog.entry_refused'),
          problems,
        });
      }

      // No `limit`: Prisma would move the guard into a subquery and stop
      // rechecking it under concurrent writes.
      const { count } = await tx.permission.updateMany({
        where: { id, managedBy: before.managedBy, updatedAt },
        data: {
          ...(edit.conditions !== undefined && { conditions: edit.conditions as Prisma.InputJsonObject }),
          ...(edit.reason !== undefined && { reason: edit.reason }),
          ...(edit.riskLevel !== undefined && { riskLevel: edit.riskLevel }),
          ...(edit.retired !== undefined && { retiredAt: after.retiredAt }),
          managedBy: PermissionOwner.Admin,
        },
      });

      if (count === 0) {
        throw new ConflictException({
          code: 'CATALOG_ENTRY_CHANGED',
          message: t('errors.permission_catalog.entry_changed'),
        });
      }

      const decisions = await loadConsentDecisionsInForce(tx, slug, this.requestedPermissionsReader);

      return {
        changed: true as const,
        id,
        before,
        after,
        catalog,
        warnings,
        consentDecisionsAffected: countConsentDecisionsLost(before, after, decisions),
      };
    });

    if (!edited.changed) {
      return { permission: edited.permission, warnings: [], consentDecisionsAffected: 0 };
    }

    await this.flushPermissionGraphs();

    this.eventEmitter.emit(
      PermissionUpdatedEvent.eventName,
      new PermissionUpdatedEvent(edited.id, auditSnapshot(edited.before), auditSnapshot(edited.after), initiatedAt),
    );

    return {
      permission: catalogPermission(edited.after, catalogDrift(edited.catalog).permissions.get(slug) ?? []),
      warnings: edited.warnings,
      consentDecisionsAffected: edited.consentDecisionsAffected,
    };
  }

  /**
   * Runs `work` in an edit's transaction: the permission catalog's edit lock
   * first, then `work`, with {@link CATALOG_EDIT_TRANSACTION_TIMEOUT_MS} to
   * do both.
   */
  private underEditLock<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.db.$transaction(
      async (tx) => {
        await lockCatalogEdits(tx);
        return work(tx);
      },
      { timeout: CATALOG_EDIT_TRANSACTION_TIMEOUT_MS },
    );
  }

  /**
   * The edit is committed, so a flush that fails is logged and the edit still
   * answers success, as at start: a graph left cached expires on its own TTL.
   */
  private async flushPermissionGraphs(): Promise<void> {
    try {
      const removed = await this.permissions.invalidateAllGraphs();
      this.logger.log(`Flushed ${removed} cached permission graph key(s) after a permission catalog edit (#772)`);
    } catch (error) {
      this.logger.error(
        'A permission catalog edit was saved, but the cached permission graphs could not be flushed; ' +
          `they expire on their own TTL (#772): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** The row with the edit applied, marked the Owner's. Retiring keeps the time a retired row already has. */
function applyEdit(row: PermissionSnapshotRow, edit: UpdatePermissionDto, now: Date): PermissionSnapshotRow {
  let retiredAt = row.retiredAt;
  if (edit.retired === true) {
    retiredAt ??= now;
  } else if (edit.retired === false) {
    retiredAt = null;
  }

  return {
    ...row,
    conditions: edit.conditions === undefined ? row.conditions : (edit.conditions as Prisma.JsonObject),
    reason: edit.reason === undefined ? row.reason : edit.reason,
    riskLevel: edit.riskLevel ?? row.riskLevel,
    managedBy: PermissionOwner.Admin,
    retiredAt,
  };
}

/**
 * Whether the edit leaves the permission as it was read, in every column an
 * edit can change. Conditions compare as JSON values, whatever the order of
 * their keys (`jsonb` keeps its own), and an absent condition is `{}`, as the
 * planner reads it. Retiring a retired permission, or reviving a live one,
 * changes nothing.
 */
function sameEntry(before: PermissionSnapshotRow, after: PermissionSnapshotRow): boolean {
  return (
    isDeepStrictEqual(before.conditions ?? {}, after.conditions ?? {}) &&
    before.reason === after.reason &&
    before.riskLevel === after.riskLevel &&
    (before.retiredAt === null) === (after.retiredAt === null)
  );
}

/**
 * The entry check on an edited permission (#772): Prisma's verdict on its
 * condition, and what the catalog guards find that the permission catalog did
 * not already have, for the permission on every holder.
 *
 * A permission the edit leaves retired confers nothing, so the catalog guards
 * see nothing of it and its holders are not judged; a start never judges a
 * retired permission either. Its condition is still checked when the edit
 * sends one: probed, and judged by the guards that read a permission alone,
 * such as the template guard. A revival is then judged like any edit, and a
 * condition the database cannot run or store never reaches the write.
 * Without a new condition a retirement is not probed: its condition runs
 * nowhere. The guards still run, so the response warns of a pair a
 * retirement leaves a role half of.
 */
async function checkEdit(
  tx: Prisma.TransactionClient,
  snapshot: CatalogSnapshot,
  catalog: CatalogSnapshot,
  after: PermissionSnapshotRow,
  conditionsSent: boolean,
): Promise<{ problems: EntryProblem[]; warnings: EntryWarning[] }> {
  const target = [{ slug: after.slug }];
  const baseline = catalogViewFromSnapshot(snapshot);
  const checked = checkCatalogEntries(baseline, catalogViewFromSnapshot(catalog), target);
  const live = after.retiredAt === null;

  if (!live && !conditionsSent) {
    return checked;
  }

  const probed = await probeConditions(tx, probedEntry(after));
  const alone = live ? [] : checkCatalogEntries(baseline, permissionAlone(baseline, after), target).problems;

  return { problems: [...probed, ...checked.problems, ...alone], warnings: checked.warnings };
}

/**
 * `view` with `row` live and held by no role: what the guards that read a
 * permission by itself, such as the template guard, judge it on.
 */
function permissionAlone(view: CatalogView, row: PermissionSnapshotRow): CatalogView {
  const [definition] = catalogViewFromSnapshot({
    permissions: [{ ...row, retiredAt: null }],
    roles: [],
    rolePermissions: [],
  }).permissions;

  return {
    permissions: [...view.permissions.filter(({ slug }) => slug !== row.slug), definition],
    rolePermissions: Object.fromEntries(
      Object.entries(view.rolePermissions).map(([role, slugs]) => [role, slugs.filter((slug) => slug !== row.slug)]),
    ),
  };
}

/** `snapshot` with the edited row in place of the one it read. */
function withPermissionRow(snapshot: CatalogSnapshot, row: PermissionSnapshotRow): CatalogSnapshot {
  return {
    ...snapshot,
    permissions: snapshot.permissions.map((permission) => (permission.slug === row.slug ? row : permission)),
  };
}

/** A row in the shape the probe takes, as `catalogViewFromSnapshot` reads it. */
function probedEntry(row: PermissionSnapshotRow): Pick<PermissionSeedDefinition, 'slug' | 'subject' | 'conditions'> {
  return {
    slug: row.slug,
    subject: row.subject as PermissionSeedDefinition['subject'],
    ...(row.conditions === null ? {} : { conditions: row.conditions as Prisma.InputJsonObject }),
  };
}

function auditSnapshot(row: PermissionSnapshotRow): PermissionSnapshot {
  return {
    slug: row.slug,
    conditions: row.conditions,
    reason: row.reason,
    riskLevel: row.riskLevel,
    managedBy: row.managedBy,
    retiredAt: row.retiredAt,
  };
}

/**
 * The drift of every entry the Owner edited that the permission catalog
 * lists: permissions by slug, roles by name. What a start would report. An
 * entry the server maintains has none, and neither has one the permission
 * catalog no longer lists, which nothing ships to differ from.
 */
function catalogDrift(snapshot: CatalogSnapshot): {
  readonly permissions: ReadonlyMap<string, readonly FieldChange[]>;
  readonly roles: ReadonlyMap<string, readonly FieldChange[]>;
} {
  const plan = planReconcile(CATALOG_MANIFEST, snapshot);

  return {
    permissions: new Map(plan.permissions.skipped.map(({ slug, drift }) => [slug, drift])),
    roles: new Map(plan.roles.skipped.map(({ name, drift }) => [name, drift])),
  };
}

function catalogOf(snapshot: CatalogSnapshot): PermissionCatalogDto {
  const { permissions: permissionDrifts, roles: roleDrifts } = catalogDrift(snapshot);

  const grants = new Map<string, CatalogGrantDto[]>();
  for (const { roleName, permissionSlug, managedBy, revokedAt } of snapshot.rolePermissions) {
    const held = grants.get(roleName) ?? [];
    held.push({ slug: permissionSlug, managedBy, revokedAt });
    grants.set(roleName, held);
  }

  return {
    permissions: [...snapshot.permissions]
      .sort((a, b) => compare(a.slug, b.slug))
      .map((row) => catalogPermission(row, permissionDrifts.get(row.slug) ?? [])),
    roles: [...snapshot.roles]
      .sort((a, b) => compare(a.name, b.name))
      .map(
        ({ name, description, managedBy }): CatalogRoleDto => ({
          name,
          description,
          managedBy,
          drift: [...(roleDrifts.get(name) ?? [])],
          grants: (grants.get(name) ?? []).sort((a, b) => compare(a.slug, b.slug)),
        }),
      ),
  };
}

/** Code-unit order: the same on every server, whatever its locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
