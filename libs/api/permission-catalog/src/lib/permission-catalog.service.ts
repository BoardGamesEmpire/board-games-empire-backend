import {
  CATALOG_MANIFEST,
  catalogViewFromSnapshot,
  checkCatalogEntries,
  DatabaseService,
  findFailingEditedEntries,
  loadCatalogSnapshot,
  lockCatalogEdits,
  PermissionOwner,
  planReconcile,
  PLUGIN_REQUESTED_PERMISSIONS_READER,
  probeConditions,
  RECONCILE_TRANSACTION_TIMEOUT_MS,
  ROLE_SCOPE,
  type CatalogSnapshot,
  type CatalogView,
  type EntryProblem,
  type EntryWarning,
  type FieldChange,
  type PermissionSeedDefinition,
  type PermissionSnapshotRow,
  type PluginRequestedPermissionsReader,
  type Prisma,
  type RolePermissionSnapshotRow,
  type RoleSnapshotRow,
} from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { PermissionsService } from '@bge/permissions';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Http } from '@status/codes';
import { isDeepStrictEqual } from 'node:util';
import { countConsentDecisionsLost, loadConsentDecisionsInForce } from './consent-effect';
import {
  catalogGrant,
  catalogListsGrant,
  catalogPermission,
  catalogRole,
  codeUnitOrder,
  type CatalogRoleDto,
  type GrantEditDto,
  type HandBackDto,
  type PermissionCatalogDto,
  type PermissionEditDto,
} from './dto/catalog.response';
import type { UpdatePermissionDto } from './dto/update-permission.dto';
import type { UpdateRoleDto } from './dto/update-role.dto';
import {
  PermissionUpdatedEvent,
  RolePermissionChangedEvent,
  RoleUpdatedEvent,
  type GrantSnapshot,
  type PermissionSnapshot,
  type RoleSnapshot,
} from './events/permission-catalog.events';
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

/** A role row as an edit reads it: the planner's columns, and what guards the write. */
const ROLE_ROW_SELECT = {
  id: true,
  updatedAt: true,
  name: true,
  description: true,
  managedBy: true,
} satisfies Prisma.RoleSelect;

/**
 * A grant row as an edit reads it. `RolePermission` has no `updatedAt`: who
 * manages the grant and its revocation are everything an edit or a start
 * changes on it, so they guard the write.
 */
const GRANT_ROW_SELECT = { id: true, managedBy: true, revokedAt: true } satisfies Prisma.RolePermissionSelect;

type GrantRow = Prisma.RolePermissionGetPayload<{ select: typeof GRANT_ROW_SELECT }>;

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
 * The Owner's reads and edits of the permission catalog (#772): a permission,
 * a role's description, and a role's grants.
 *
 * Every edit first takes the permission catalog's edit lock
 * (`lockCatalogEdits`), which a start's reconcile takes too, so edits and
 * starts run one at a time and each one's check reads the permission catalog
 * as the last of them left it.
 *
 * An edit is checked before it is written, and refused with the problems the
 * check found: Prisma's verdict on a condition (`probeConditions`) and what
 * the catalog guards find that the permission catalog did not already have
 * (`checkCatalogEntries`). One that would leave the Owner without
 * `manage:all` is refused too (`refuseOwnerLockout`). Then it is written in
 * the same transaction, marked as managed by the Owner so bootstrap keeps it,
 * and guarded by the row as it was read, so a write that never took the lock,
 * such as one made by hand in the database, answers 409 rather than being
 * overwritten.
 *
 * After the commit every cached permission graph goes, since what a role
 * confers changed, and the edit is audited. An edit that changes nothing
 * writes nothing, and none of this happens. A role's description confers
 * nothing, so it is neither checked nor followed by a flush.
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
      throw new CodedHttpException(Http.BadRequest, 'CATALOG_EDIT_EMPTY', t('errors.permission_catalog.edit_empty'));
    }

    const initiatedAt = new Date();

    const edited = await this.underEditLock(async (tx) => {
      const row = await readEditablePermission(tx, slug);

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
        throw new CodedHttpException(
          Http.UnprocessableEntity,
          'CATALOG_ENTRY_REFUSED',
          t('errors.permission_catalog.entry_refused'),
          { fields: { problems } },
        );
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
        throw permissionChanged();
      }

      // No consent decision is judged on the reason, so an edit of the reason
      // alone takes nothing from a plugin, and the decisions are not read
      // under the edit lock to say so.
      const reasonOnly = sameEntry({ ...before, reason: after.reason }, after);
      const consentDecisionsAffected = reasonOnly
        ? 0
        : countConsentDecisionsLost(
            before,
            after,
            await loadConsentDecisionsInForce(tx, slug, this.requestedPermissionsReader),
          );

      return {
        changed: true as const,
        id,
        before,
        after,
        catalog,
        warnings,
        consentDecisionsAffected,
      };
    });

    if (!edited.changed) {
      return { permission: edited.permission, warnings: [], consentDecisionsAffected: 0 };
    }

    this.eventEmitter.emit(
      PermissionUpdatedEvent.eventName,
      new PermissionUpdatedEvent(edited.id, auditSnapshot(edited.before), auditSnapshot(edited.after), initiatedAt),
    );

    await this.flushPermissionGraphs();

    return {
      permission: catalogPermission(edited.after, catalogDrift(edited.catalog).permissions.get(slug) ?? []),
      warnings: edited.warnings,
      consentDecisionsAffected: edited.consentDecisionsAffected,
    };
  }

  /**
   * Sets one role's description, and marks the role as managed by the Owner,
   * so the next start keeps it (#772). Sending the current description again
   * answers the role as it is and writes nothing.
   *
   * A description changes nothing the role confers, so the entry check has
   * nothing to judge, and no cached permission graph holds one, so none is
   * flushed.
   */
  async updateRole(name: string, edit: UpdateRoleDto): Promise<CatalogRoleDto> {
    const initiatedAt = new Date();

    const edited = await this.underEditLock(async (tx) => {
      const { id, updatedAt, ...before } = await readEditableRole(tx, name);
      const snapshot = await loadCatalogSnapshot(tx);

      if (before.description === edit.description) {
        return { changed: false as const, role: roleOf(snapshot, before) };
      }

      const after: RoleSnapshotRow = { ...before, description: edit.description, managedBy: PermissionOwner.Admin };

      // No `limit`, as for a permission: the guard must be rechecked on the row.
      const { count } = await tx.role.updateMany({
        where: { id, managedBy: before.managedBy, updatedAt },
        data: { description: after.description, managedBy: PermissionOwner.Admin },
      });

      if (count === 0) {
        throw roleChanged();
      }

      return { changed: true as const, id, before, after, role: roleOf(withRoleRow(snapshot, after), after) };
    });

    // Deliberately no `flushPermissionGraphs()` here, unlike every grant or
    // permission edit (#772). A cached graph holds a role's name and grants,
    // never its description, so a flush would only make every signed-in
    // user reload a graph that hasn't changed.
    if (edited.changed) {
      this.eventEmitter.emit(
        RoleUpdatedEvent.eventName,
        new RoleUpdatedEvent(edited.id, roleAudit(edited.before), roleAudit(edited.after), initiatedAt),
      );
    }

    return edited.role;
  }

  /**
   * Gives a role a permission, or gives back a grant that was revoked (#772).
   * The grant is the Owner's either way, so the next start keeps it: a new
   * grant is created managed by the Owner, and a revoked one is cleared and
   * marked so. A grant the role already holds is answered as it is, and
   * nothing is written.
   *
   * The grant is checked on the permission catalog it would make, against
   * every guard (`checkCatalogEntries`): a grant whose condition names roles
   * other than the one given it confers nothing, and is refused. A grant on
   * `User` is judged on every holder of the permission. Adding a grant
   * changes no condition, so nothing is probed.
   *
   * A grant the check cannot see is refused, so it fails closed. That is a
   * grant to a role `ROLE_SCOPE` gives no scope, whose grants the check
   * leaves out (until custom roles get a scope, #1170), and a grant of a
   * retired permission, since the check judges live permissions only.
   * Reviving the permission first checks it on every role that holds it,
   * then the grant is checked as it is added.
   */
  async addGrant(roleName: string, slug: string): Promise<GrantEditDto> {
    const initiatedAt = new Date();

    const edited = await this.underEditLock(async (tx) => {
      const { role, permission, grant } = await readGrant(tx, roleName, slug);

      if (!Object.hasOwn(ROLE_SCOPE, roleName)) {
        throw new CodedHttpException(
          Http.Conflict,
          'CATALOG_ROLE_NOT_JUDGEABLE',
          t('errors.permission_catalog.role_not_judgeable', { name: roleName }),
        );
      }

      if (permission.retiredAt !== null) {
        throw new CodedHttpException(
          Http.Conflict,
          'CATALOG_PERMISSION_RETIRED',
          t('errors.permission_catalog.permission_retired', { slug }),
        );
      }

      const before = grant === null ? null : grantRow(roleName, slug, grant);
      if (before !== null && before.revokedAt === null) {
        return { changed: false as const, grant: before };
      }

      const after: RolePermissionSnapshotRow = {
        roleName,
        permissionSlug: slug,
        managedBy: PermissionOwner.Admin,
        revokedAt: null,
      };
      const warnings = await checkGrantChange(tx, roleName, slug, after);

      const id =
        grant === null
          ? await createGrant(tx, role.id, permission.id)
          : await writeGrant(tx, grant, { revokedAt: null, managedBy: PermissionOwner.Admin });

      return { changed: true as const, id, before, after, warnings };
    });

    if (!edited.changed) {
      return { grant: catalogGrant(edited.grant), warnings: [] };
    }

    this.eventEmitter.emit(
      RolePermissionChangedEvent.eventName,
      new RolePermissionChangedEvent(
        edited.id,
        edited.before === null ? null : grantAudit(edited.before),
        grantAudit(edited.after),
        initiatedAt,
      ),
    );

    await this.flushPermissionGraphs();

    return { grant: catalogGrant(edited.after), warnings: edited.warnings };
  }

  /**
   * Takes a grant from a role (#772). A grant the permission catalog ships is
   * kept, revoked and managed by the Owner, so the next start doesn't give it
   * back; one it doesn't ship, which this server added, is deleted. A shipped
   * grant the Owner already revoked is answered as it is, and nothing is
   * written.
   *
   * Taking a grant can still break another: the guards excuse every role
   * holding a permission `User` holds, so revoking `User`'s grant can leave
   * another role's grant of it failing open. The change is checked as an
   * added grant is, and refused on any problem; the warnings, such as a role
   * left holding one half of a pair, are answered. Revoking the Owner's
   * `manage:all` is refused.
   *
   * A grant on a role `ROLE_SCOPE` gives no scope can be revoked, though one
   * can't be added (#1170). Taking it only narrows what that role confers.
   * The check leaves the role's grants out either way, and the role is not
   * `User`, so its grant excuses no other holder: no finding about any other
   * role changes. Refusing would leave in place the one grant the check
   * can't see.
   */
  async revokeGrant(roleName: string, slug: string): Promise<GrantEditDto> {
    const initiatedAt = new Date();

    const edited = await this.underEditLock(async (tx) => {
      const { grant } = await readGrant(tx, roleName, slug);
      if (grant === null) {
        throw grantNotFound(roleName, slug);
      }

      const before = grantRow(roleName, slug, grant);
      const after: RolePermissionSnapshotRow | null = catalogListsGrant(roleName, slug)
        ? { ...before, managedBy: PermissionOwner.Admin, revokedAt: before.revokedAt ?? initiatedAt }
        : null;

      if (after !== null && sameGrant(before, after)) {
        return { changed: false as const, grant: before };
      }

      const warnings = await checkGrantChange(tx, roleName, slug, after);

      if (after === null) {
        await deleteGrant(tx, grant);
      } else {
        await writeGrant(tx, grant, { managedBy: PermissionOwner.Admin, revokedAt: after.revokedAt });
      }

      return { changed: true as const, id: grant.id, before, after, warnings };
    });

    if (!edited.changed) {
      return { grant: catalogGrant(edited.grant), warnings: [] };
    }

    this.eventEmitter.emit(
      RolePermissionChangedEvent.eventName,
      new RolePermissionChangedEvent(
        edited.id,
        grantAudit(edited.before),
        edited.after === null ? null : grantAudit(edited.after),
        initiatedAt,
      ),
    );

    await this.flushPermissionGraphs();

    return { grant: edited.after === null ? null : catalogGrant(edited.after), warnings: edited.warnings };
  }

  // The three hand-backs flush no permission graph (#772): they change only
  // `managedBy`, which no loader or cached graph reads, so nothing conferred
  // changes until the next start, which flushes after a reconcile that writes
  // rows. The edit routes flush because what they write is conferred at once.

  /**
   * Hands a permission back to the server (#772): marks it `System`, so the
   * next start brings it in line with the permission catalog this version
   * ships. Nothing else is written, so the permission keeps its edits until
   * that start. A permission the permission catalog doesn't list is retired
   * at that start, which the answer says.
   *
   * A permission already `System` is answered the same way and nothing is
   * written: no event, no flush.
   */
  async handBackPermission(slug: string): Promise<HandBackDto> {
    const initiatedAt = new Date();

    const handedBack = await this.underEditLock(async (tx) => {
      const { id, updatedAt, ...before } = await readEditablePermission(tx, slug);
      const snapshot = await loadCatalogSnapshot(tx);

      if (before.managedBy === PermissionOwner.System) {
        return { changed: false as const, nextStart: permissionNextStart(snapshot, slug) };
      }

      const after: PermissionSnapshotRow = { ...before, managedBy: PermissionOwner.System };

      // No `limit`, as for an edit: the guard must be rechecked on the row.
      const { count } = await tx.permission.updateMany({
        where: { id, managedBy: before.managedBy, updatedAt },
        data: { managedBy: PermissionOwner.System },
      });

      if (count === 0) {
        throw permissionChanged();
      }

      return {
        changed: true as const,
        id,
        before,
        after,
        nextStart: permissionNextStart(withPermissionRow(snapshot, after), slug),
      };
    });

    if (handedBack.changed) {
      this.eventEmitter.emit(
        PermissionUpdatedEvent.eventName,
        new PermissionUpdatedEvent(
          handedBack.id,
          auditSnapshot(handedBack.before),
          auditSnapshot(handedBack.after),
          initiatedAt,
        ),
      );
    }

    return { nextStart: handedBack.nextStart };
  }

  /**
   * Hands a role back to the server (#772): marks it `System`, so the next
   * start restores its description.
   */
  async handBackRole(name: string): Promise<HandBackDto> {
    const initiatedAt = new Date();

    const handedBack = await this.underEditLock(async (tx) => {
      const { id, updatedAt, ...before } = await readEditableRole(tx, name);
      const snapshot = await loadCatalogSnapshot(tx);

      if (before.managedBy === PermissionOwner.System) {
        return { changed: false as const, nextStart: roleNextStart(snapshot, name) };
      }

      const after: RoleSnapshotRow = { ...before, managedBy: PermissionOwner.System };

      const { count } = await tx.role.updateMany({
        where: { id, managedBy: before.managedBy, updatedAt },
        data: { managedBy: PermissionOwner.System },
      });

      if (count === 0) {
        throw roleChanged();
      }

      return {
        changed: true as const,
        id,
        before,
        after,
        nextStart: roleNextStart(withRoleRow(snapshot, after), name),
      };
    });

    if (handedBack.changed) {
      this.eventEmitter.emit(
        RoleUpdatedEvent.eventName,
        new RoleUpdatedEvent(handedBack.id, roleAudit(handedBack.before), roleAudit(handedBack.after), initiatedAt),
      );
    }

    return { nextStart: handedBack.nextStart };
  }

  /**
   * Hands a grant back to the server (#772): marks it `System`, and the next
   * start does what the permission catalog says of it: gives it back if it
   * was revoked and the permission catalog lists it, deletes it if the
   * permission catalog doesn't, and leaves a live listed grant as it is. A
   * revoked grant the Owner's other edits make fail the entry check is
   * withheld instead: left revoked, and judged again at each start. The
   * grant is not deleted here, so the answer is what will happen, not what
   * has.
   */
  async handBackGrant(roleName: string, slug: string): Promise<HandBackDto> {
    const initiatedAt = new Date();

    const handedBack = await this.underEditLock(async (tx) => {
      const { grant } = await readGrant(tx, roleName, slug);
      if (grant === null) {
        throw grantNotFound(roleName, slug);
      }

      const before = grantRow(roleName, slug, grant);
      const snapshot = await loadCatalogSnapshot(tx);

      if (before.managedBy === PermissionOwner.System) {
        return { changed: false as const, answer: await grantNextStart(tx, snapshot, roleName, slug) };
      }

      const after: RolePermissionSnapshotRow = { ...before, managedBy: PermissionOwner.System };
      await writeGrant(tx, grant, { managedBy: PermissionOwner.System });

      return {
        changed: true as const,
        id: grant.id,
        before,
        after,
        answer: await grantNextStart(tx, withGrantRow(snapshot, roleName, slug, after), roleName, slug),
      };
    });

    if (handedBack.changed) {
      this.eventEmitter.emit(
        RolePermissionChangedEvent.eventName,
        new RolePermissionChangedEvent(
          handedBack.id,
          grantAudit(handedBack.before),
          grantAudit(handedBack.after),
          initiatedAt,
        ),
      );
    }

    return handedBack.answer;
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
   *
   * Every caller emits its audit event before this, not after. The flush
   * waits on Redis, and the shared cache client sets no command timeout, so a
   * Redis that stops replying without closing the connection would otherwise
   * hold back the audit record of an edit that is already saved. The audit
   * listener reads no permission graph, so it needs nothing this flush does
   * (#772).
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
 * The permission, read under the edit lock. A slug no permission has answers
 * 404; a plugin's permission belongs to its plugin, which keeps it in line
 * with its manifest, so the Owner's edit or hand-back would take it from the
 * plugin.
 */
async function readEditablePermission(tx: Prisma.TransactionClient, slug: string) {
  const row = await tx.permission.findUnique({ where: { slug }, select: PERMISSION_ROW_SELECT });
  if (row === null) {
    throw permissionNotFound(slug);
  }

  if (row.managedBy === PermissionOwner.Plugin) {
    throw new CodedHttpException(
      Http.Conflict,
      'CATALOG_ENTRY_NOT_EDITABLE',
      t('errors.permission_catalog.entry_not_editable', { slug }),
    );
  }

  return row;
}

/**
 * What the next start changes about a permission on `snapshot` (#772): the
 * planner's changes to its columns, and `retiredAt` when the start revives it
 * (`to` null) or retires it because the permission catalog no longer lists it
 * (`to` 'retired': the start's own time, which isn't known yet).
 */
function permissionNextStart(snapshot: CatalogSnapshot, slug: string): FieldChange[] {
  const { update, revive, retire } = planReconcile(CATALOG_MANIFEST, snapshot).permissions;
  const changes: FieldChange[] = [...(update.find((entry) => entry.slug === slug)?.changes ?? [])];

  if (revive.includes(slug)) {
    const retiredAt = snapshot.permissions.find((row) => row.slug === slug)?.retiredAt ?? null;
    changes.push({ field: 'retiredAt', from: retiredAt, to: null });
  }

  if (retire.includes(slug)) {
    changes.push({ field: 'retiredAt', from: null, to: 'retired' });
  }

  return changes;
}

/** What the next start changes about a role on `snapshot` (#772): its description, if it differs. */
function roleNextStart(snapshot: CatalogSnapshot, name: string): FieldChange[] {
  const { update } = planReconcile(CATALOG_MANIFEST, snapshot).roles;

  return [...(update.find((entry) => entry.name === name)?.changes ?? [])];
}

/**
 * What the next start does to a grant on `snapshot` (#772), or `[]` when it
 * leaves it as it is. Planned as a start plans, after the entry check a start
 * runs (`findFailingEditedEntries`): a shipped grant the Owner's other edits
 * make fail is withheld, not given back, and the answer says so, with why.
 * Without the check, the answer would promise a grant the start then leaves
 * revoked.
 *
 * `tx` must be an interactive transaction's client: the check probes the
 * Owner's conditions in a savepoint.
 */
async function grantNextStart(
  tx: Prisma.TransactionClient,
  snapshot: CatalogSnapshot,
  roleName: string,
  slug: string,
): Promise<HandBackDto> {
  const failing = await findFailingEditedEntries(tx, CATALOG_MANIFEST, snapshot);
  const { restore, delete: removed, withheld } = planReconcile(CATALOG_MANIFEST, snapshot, failing).rolePermissions;
  const isThisGrant = (edge: { roleName: string; permissionSlug: string }) =>
    edge.roleName === roleName && edge.permissionSlug === slug;

  const held = withheld.find(isThisGrant);
  if (held !== undefined) {
    return { nextStart: 'grant-withheld', problems: [...held.problems] };
  }

  if (restore.some(isThisGrant)) {
    return { nextStart: 'grant-restored' };
  }

  return { nextStart: removed.some(isThisGrant) ? 'grant-removed' : [] };
}

/**
 * The role, read under the edit lock. A role this server doesn't have
 * answers 404; a plugin's role belongs to its plugin, as a plugin's
 * permission does, so neither it nor its grants are the Owner's to change.
 */
async function readEditableRole(tx: Prisma.TransactionClient, name: string) {
  const role = await tx.role.findUnique({ where: { name }, select: ROLE_ROW_SELECT });
  if (role === null) {
    throw new CodedHttpException(
      Http.NotFound,
      'CATALOG_ENTRY_NOT_FOUND',
      t('errors.permission_catalog.role_not_found', { name }),
    );
  }

  if (role.managedBy === PermissionOwner.Plugin) {
    throw new CodedHttpException(
      Http.Conflict,
      'CATALOG_ENTRY_NOT_EDITABLE',
      t('errors.permission_catalog.role_not_editable', { name }),
    );
  }

  return role;
}

/**
 * The role, the permission and the grant between them, if there is one, read
 * under the edit lock. An unknown role or permission answers 404. A plugin's
 * permission belongs to its plugin, as do its grants and a plugin's grant,
 * so giving or taking any of them is refused (#772), as an edit of a plugin's
 * permission is.
 */
async function readGrant(
  tx: Prisma.TransactionClient,
  roleName: string,
  slug: string,
): Promise<{ role: { id: string }; permission: { id: string; retiredAt: Date | null }; grant: GrantRow | null }> {
  const role = await readEditableRole(tx, roleName);

  const permission = await tx.permission.findUnique({
    where: { slug },
    select: { id: true, retiredAt: true, managedBy: true },
  });
  if (permission === null) {
    throw permissionNotFound(slug);
  }

  if (permission.managedBy === PermissionOwner.Plugin) {
    throw new CodedHttpException(
      Http.Conflict,
      'CATALOG_ENTRY_NOT_EDITABLE',
      t('errors.permission_catalog.permission_not_grantable', { slug }),
    );
  }

  const grant = await tx.rolePermission.findUnique({
    where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
    select: GRANT_ROW_SELECT,
  });

  if (grant?.managedBy === PermissionOwner.Plugin) {
    throw new CodedHttpException(
      Http.Conflict,
      'CATALOG_ENTRY_NOT_EDITABLE',
      t('errors.permission_catalog.grant_not_editable', { name: roleName, slug }),
    );
  }

  return { role, permission, grant };
}

/**
 * The entry check on a grant added or taken (#772), on the permission
 * catalog as the change would leave it: `after` in place of the grant, or no
 * grant for null. The change may not leave the Owner without `manage:all`,
 * and may add no problem the catalog guards find for the grant. A grant on
 * `User` is judged on every holder of the permission, since `User` holding
 * a permission is what excuses every other holder from the
 * unconditioned-grant guards. Answers the warnings.
 */
async function checkGrantChange(
  tx: Prisma.TransactionClient,
  roleName: string,
  slug: string,
  after: RolePermissionSnapshotRow | null,
): Promise<EntryWarning[]> {
  const snapshot = await loadCatalogSnapshot(tx);
  const catalog = withGrantRow(snapshot, roleName, slug, after);
  refuseOwnerLockout(catalog);

  const { problems, warnings } = checkCatalogEntries(
    catalogViewFromSnapshot(snapshot),
    catalogViewFromSnapshot(catalog),
    [{ roleName, slug }],
  );

  if (problems.length > 0) {
    throw new CodedHttpException(
      Http.UnprocessableEntity,
      'CATALOG_ENTRY_REFUSED',
      t('errors.permission_catalog.grant_refused'),
      { fields: { problems } },
    );
  }

  return warnings;
}

/**
 * Creates the grant, managed by the Owner. Skipping a duplicate is the guard
 * a new row has: a grant some writer that never took the lock created after
 * the read leaves nothing created, and answers 409 rather than a
 * unique-constraint failure.
 */
async function createGrant(tx: Prisma.TransactionClient, roleId: string, permissionId: string): Promise<string> {
  const [created] = await tx.rolePermission.createManyAndReturn({
    data: [{ roleId, permissionId, managedBy: PermissionOwner.Admin }],
    skipDuplicates: true,
    select: { id: true },
  });

  if (created === undefined) {
    throw grantChanged();
  }

  return created.id;
}

/**
 * Writes the grant, guarded by who managed it and its revocation as they
 * were read. No `limit`: Prisma would move the guard into a subquery and stop
 * rechecking it under concurrent writes.
 */
async function writeGrant(
  tx: Prisma.TransactionClient,
  grant: GrantRow,
  data: Partial<Pick<RolePermissionSnapshotRow, 'managedBy' | 'revokedAt'>>,
): Promise<string> {
  const { count } = await tx.rolePermission.updateMany({ where: guardOf(grant), data });
  if (count === 0) {
    throw grantChanged();
  }

  return grant.id;
}

/** Deletes the grant, guarded as {@link writeGrant} guards a write. */
async function deleteGrant(tx: Prisma.TransactionClient, grant: GrantRow): Promise<void> {
  const { count } = await tx.rolePermission.deleteMany({ where: guardOf(grant) });
  if (count === 0) {
    throw grantChanged();
  }
}

function guardOf({ id, managedBy, revokedAt }: GrantRow): Prisma.RolePermissionWhereInput {
  return { id, managedBy, revokedAt };
}

// One builder per refusal the routes answer in more than one place, so each
// keeps one code and one message.

function permissionNotFound(slug: string): CodedHttpException {
  return new CodedHttpException(
    Http.NotFound,
    'CATALOG_ENTRY_NOT_FOUND',
    t('errors.permission_catalog.entry_not_found', { slug }),
  );
}

function grantNotFound(roleName: string, slug: string): CodedHttpException {
  return new CodedHttpException(
    Http.NotFound,
    'CATALOG_ENTRY_NOT_FOUND',
    t('errors.permission_catalog.grant_not_found', { name: roleName, slug }),
  );
}

function permissionChanged(): CodedHttpException {
  return new CodedHttpException(Http.Conflict, 'CATALOG_ENTRY_CHANGED', t('errors.permission_catalog.entry_changed'));
}

function roleChanged(): CodedHttpException {
  return new CodedHttpException(Http.Conflict, 'CATALOG_ENTRY_CHANGED', t('errors.permission_catalog.role_changed'));
}

function grantChanged(): CodedHttpException {
  return new CodedHttpException(Http.Conflict, 'CATALOG_ENTRY_CHANGED', t('errors.permission_catalog.grant_changed'));
}

/** A grant row by the names the snapshot speaks in. */
function grantRow(roleName: string, slug: string, { managedBy, revokedAt }: GrantRow): RolePermissionSnapshotRow {
  return { roleName, permissionSlug: slug, managedBy, revokedAt };
}

/** Whether two states of one grant are the same: who manages it, and whether it is revoked. */
function sameGrant(a: RolePermissionSnapshotRow, b: RolePermissionSnapshotRow): boolean {
  return a.managedBy === b.managedBy && (a.revokedAt === null) === (b.revokedAt === null);
}

/** `snapshot` with `grant` in place of the grant of `slug` to `roleName`, or without it for null. */
function withGrantRow(
  snapshot: CatalogSnapshot,
  roleName: string,
  slug: string,
  grant: RolePermissionSnapshotRow | null,
): CatalogSnapshot {
  const others = snapshot.rolePermissions.filter((row) => !(row.roleName === roleName && row.permissionSlug === slug));

  return { ...snapshot, rolePermissions: grant === null ? others : [...others, grant] };
}

/** `snapshot` with the edited role row in place of the one it read. */
function withRoleRow(snapshot: CatalogSnapshot, row: RoleSnapshotRow): CatalogSnapshot {
  return { ...snapshot, roles: snapshot.roles.map((role) => (role.name === row.name ? row : role)) };
}

/** `row` as the routes return it, with its grants and its drift in `snapshot`. */
function roleOf(snapshot: CatalogSnapshot, row: RoleSnapshotRow): CatalogRoleDto {
  return catalogRole(
    row,
    snapshot.rolePermissions.filter(({ roleName }) => roleName === row.name),
    catalogDrift(snapshot).roles.get(row.name) ?? [],
  );
}

function roleAudit({ name, description, managedBy }: RoleSnapshotRow): RoleSnapshot {
  return { name, description, managedBy };
}

function grantAudit({ roleName, permissionSlug, managedBy, revokedAt }: RolePermissionSnapshotRow): GrantSnapshot {
  return { roleName, permissionSlug, managedBy, revokedAt };
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

  const grants = new Map<string, RolePermissionSnapshotRow[]>();
  for (const grant of snapshot.rolePermissions) {
    const held = grants.get(grant.roleName) ?? [];
    held.push(grant);
    grants.set(grant.roleName, held);
  }

  return {
    permissions: [...snapshot.permissions]
      .sort((a, b) => codeUnitOrder(a.slug, b.slug))
      .map((row) => catalogPermission(row, permissionDrifts.get(row.slug) ?? [])),
    roles: [...snapshot.roles]
      .sort((a, b) => codeUnitOrder(a.name, b.name))
      .map((row) => catalogRole(row, grants.get(row.name) ?? [], roleDrifts.get(row.name) ?? [])),
  };
}
