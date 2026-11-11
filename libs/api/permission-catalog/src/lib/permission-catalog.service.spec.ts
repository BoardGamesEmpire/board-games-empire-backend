import {
  CATALOG_EDIT_LOCK_NAME,
  CATALOG_MANIFEST,
  loadCatalogSnapshot,
  PermissionOwner,
  PLUGIN_REQUESTED_PERMISSIONS_READER,
  PluginGrantScope,
  PluginGrantStatus,
  probeConditions,
  RECONCILE_TRANSACTION_TIMEOUT_MS,
  ResourceType,
  RiskLevel,
  SystemRole,
  type CatalogSnapshot,
  type EntryProblem,
  type PermissionSnapshotRow,
  type Prisma,
  type RolePermissionSnapshotRow,
  type RoleSnapshotRow,
} from '@bge/database';
import { PermissionsService } from '@bge/permissions';
import { CacheFlushError } from '@bge/redis';
import { createTestingModuleWithDb, rawQueryText, unwrapTransaction, type MockDatabaseService } from '@bge/testing';
import { ConflictException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  PermissionUpdatedEvent,
  RolePermissionChangedEvent,
  RoleUpdatedEvent,
} from './events/permission-catalog.events';
import { CATALOG_EDIT_TRANSACTION_TIMEOUT_MS, PermissionCatalogService } from './permission-catalog.service';

// The permission catalog's reads and Prisma's verdict are the database's; everything the
// service decides from them (the views, the guards, the drift) runs for real.
jest.mock('@bge/database', () => ({
  ...jest.requireActual('@bge/database'),
  loadCatalogSnapshot: jest.fn(),
  probeConditions: jest.fn(),
}));

const loadSnapshot = loadCatalogSnapshot as jest.MockedFunction<typeof loadCatalogSnapshot>;
const probe = probeConditions as jest.MockedFunction<typeof probeConditions>;

/** The permission catalog as a converged database holds it: every row the server's. */
const shippedSnapshot = (): CatalogSnapshot => ({
  permissions: CATALOG_MANIFEST.permissions.map((entry): PermissionSnapshotRow => ({
    slug: entry.slug,
    action: entry.action,
    subject: entry.subject,
    fields: [...(entry.fields ?? [])],
    conditions: (entry.conditions ?? {}) as Prisma.JsonValue,
    inverted: false,
    reason: entry.reason,
    riskLevel: entry.riskLevel,
    managedBy: PermissionOwner.System,
    retiredAt: null,
  })),
  roles: CATALOG_MANIFEST.roles.map(({ name, description }) => ({
    name,
    description,
    managedBy: PermissionOwner.System,
  })),
  rolePermissions: Object.entries(CATALOG_MANIFEST.rolePermissions).flatMap(([roleName, slugs]) =>
    slugs.map((permissionSlug) => ({
      roleName,
      permissionSlug,
      managedBy: PermissionOwner.System,
      revokedAt: null,
    })),
  ),
});

/** `snapshot` with one permission row changed. */
const withPermission = (
  snapshot: CatalogSnapshot,
  slug: string,
  overrides: Partial<PermissionSnapshotRow>,
): CatalogSnapshot => ({
  ...snapshot,
  permissions: snapshot.permissions.map((row) => (row.slug === slug ? { ...row, ...overrides } : row)),
});

const rowOf = (snapshot: CatalogSnapshot, slug: string): PermissionSnapshotRow => {
  const row = snapshot.permissions.find((permission) => permission.slug === slug);
  if (row === undefined) {
    throw new Error(`The snapshot has no '${slug}'`);
  }
  return row;
};

/** An event permission household and event roles hold under a condition (#772). */
const SLUG = 'update:event';
const ID = 'permission-1';
const UPDATED_AT = new Date('2026-11-01T00:00:00.000Z');

/** Row ids the role routes' reads answer with, derived from the names so a grant read can find its row. */
const roleId = (name: string) => `role:${name}`;
const permissionId = (slug: string) => `permission:${slug}`;
const grantId = (roleName: string, slug: string) => `grant:${roleName}:${slug}`;
const ROLE_UPDATED_AT = new Date('2026-11-03T00:00:00.000Z');
const REVOKED_AT = new Date('2026-11-02T00:00:00.000Z');

const roleRowOf = (snapshot: CatalogSnapshot, name: string): RoleSnapshotRow => {
  const row = snapshot.roles.find((role) => role.name === name);
  if (row === undefined) {
    throw new Error(`The snapshot has no role '${name}'`);
  }
  return row;
};

/** `snapshot` with one role row changed. */
const withRole = (snapshot: CatalogSnapshot, name: string, overrides: Partial<RoleSnapshotRow>): CatalogSnapshot => ({
  ...snapshot,
  roles: snapshot.roles.map((row) => (row.name === name ? { ...row, ...overrides } : row)),
});

/**
 * `snapshot` with the grant of `slug` to `roleName` set, starting from the
 * grant it has (or a live one the server manages), or without it for null.
 */
const withGrant = (
  snapshot: CatalogSnapshot,
  roleName: string,
  slug: string,
  overrides: Partial<RolePermissionSnapshotRow> | null,
): CatalogSnapshot => {
  const isThisGrant = (grant: RolePermissionSnapshotRow) =>
    grant.roleName === roleName && grant.permissionSlug === slug;
  const current = snapshot.rolePermissions.find(isThisGrant) ?? {
    roleName,
    permissionSlug: slug,
    managedBy: PermissionOwner.System,
    revokedAt: null,
  };
  const others = snapshot.rolePermissions.filter((grant) => !isThisGrant(grant));

  return { ...snapshot, rolePermissions: overrides === null ? others : [...others, { ...current, ...overrides }] };
};

describe('PermissionCatalogService (#772)', () => {
  let service: PermissionCatalogService;
  let db: MockDatabaseService;
  let snapshot: CatalogSnapshot;
  const order: string[] = [];
  const permissions = { invalidateAllGraphs: jest.fn() };
  const emitter = { emit: jest.fn() };
  /** Every plugin's active manifest requests the edited slug at every scope. */
  const reader = { read: jest.fn() };

  /** The row as `findUnique` reads it: the snapshot's columns with its id and stamp. */
  const stubRow = (slug = SLUG, overrides: Partial<PermissionSnapshotRow> = {}) => {
    db.permission.findUnique.mockResolvedValue({
      ...rowOf(snapshot, slug),
      ...overrides,
      id: ID,
      updatedAt: UPDATED_AT,
    } as never);
  };

  beforeEach(async () => {
    const ctx = await createTestingModuleWithDb({
      providers: [
        PermissionCatalogService,
        { provide: PermissionsService, useValue: permissions },
        { provide: EventEmitter2, useValue: emitter },
        { provide: PLUGIN_REQUESTED_PERMISSIONS_READER, useValue: reader },
      ],
    });
    reader.read.mockReset().mockReturnValue({
      valid: true,
      requested: Object.values(PluginGrantScope).map((scopeType) => ({ slug: SLUG, scopeType })),
    });

    db = ctx.db;
    service = ctx.module.get(PermissionCatalogService);

    order.length = 0;
    unwrapTransaction(db);
    const runTransaction = db.$transaction.getMockImplementation();
    db.$transaction.mockImplementation((async (...args: Parameters<MockDatabaseService['$transaction']>) => {
      const result = await (runTransaction as (...a: unknown[]) => Promise<unknown>)(...args);
      order.push('commit');
      return result;
    }) as never);

    snapshot = shippedSnapshot();
    loadSnapshot.mockReset().mockImplementation(async () => snapshot);
    probe.mockReset().mockResolvedValue([]);
    permissions.invalidateAllGraphs.mockReset().mockImplementation(async () => {
      order.push('flush');
      return 3;
    });
    emitter.emit.mockReset().mockImplementation(() => {
      order.push('emit');
      return true;
    });
    db.permission.updateMany.mockResolvedValue({ count: 1 });
    db.pluginGrant.findMany.mockResolvedValue([]);
  });

  describe('getCatalog', () => {
    it("reports an Owner's permission with its drift from the permission catalog, and none for the server's (#772)", async () => {
      const shipped = rowOf(snapshot, SLUG);
      snapshot = withPermission(snapshot, SLUG, { reason: 'Edited on this server', managedBy: PermissionOwner.Admin });

      const { permissions: rows } = await service.getCatalog();

      expect(rows.find(({ slug }) => slug === SLUG)).toEqual(
        expect.objectContaining({
          slug: SLUG,
          reason: 'Edited on this server',
          managedBy: PermissionOwner.Admin,
          drift: [{ field: 'reason', from: 'Edited on this server', to: shipped.reason }],
        }),
      );
      expect(rows.filter(({ slug }) => slug !== SLUG).every(({ drift }) => drift.length === 0)).toBe(true);
    });

    it('lists every role with its grants, a revoked grant carrying when it was revoked (#772)', async () => {
      const revokedAt = new Date('2026-11-02T00:00:00.000Z');
      snapshot = {
        ...snapshot,
        roles: snapshot.roles.map((role) =>
          role.name === SystemRole.HouseholdMember
            ? { ...role, description: 'Edited', managedBy: PermissionOwner.Admin }
            : role,
        ),
        rolePermissions: snapshot.rolePermissions.map((grant) =>
          grant.roleName === SystemRole.User && grant.permissionSlug === 'create:event'
            ? { ...grant, managedBy: PermissionOwner.Admin, revokedAt }
            : grant,
        ),
      };

      const { roles } = await service.getCatalog();

      expect(roles.map(({ name }) => name)).toEqual(CATALOG_MANIFEST.roles.map(({ name }) => name).sort());
      expect(roles.find(({ name }) => name === SystemRole.User)?.grants).toContainEqual({
        slug: 'create:event',
        managedBy: PermissionOwner.Admin,
        revokedAt,
        shipped: true,
      });
      expect(roles.find(({ name }) => name === SystemRole.HouseholdMember)).toEqual(
        expect.objectContaining({
          description: 'Edited',
          managedBy: PermissionOwner.Admin,
          drift: [
            {
              field: 'description',
              from: 'Edited',
              to: CATALOG_MANIFEST.roles.find(({ name }) => name === SystemRole.HouseholdMember)?.description,
            },
          ],
        }),
      );
    });

    // Both of these grants are the Owner's and live; only `shipped` tells a
    // grant this server added from a shipped one the Owner revoked and gave back.
    it('says whether the permission catalog this version ships each permission and each grant (#772)', async () => {
      snapshot = withGrant(snapshot, SystemRole.User, 'create:event', { managedBy: PermissionOwner.Admin });
      snapshot = withGrant(snapshot, SystemRole.HouseholdGuest, 'read:event_game:household', {
        managedBy: PermissionOwner.Admin,
      });
      snapshot = {
        ...snapshot,
        permissions: [
          ...snapshot.permissions,
          { ...rowOf(snapshot, SLUG), slug: 'read:made_up', retiredAt: new Date('2026-11-04T00:00:00.000Z') },
        ],
      };

      const { permissions: rows, roles } = await service.getCatalog();
      const grantOf = (role: string, slug: string) =>
        roles.find(({ name }) => name === role)?.grants.find((grant) => grant.slug === slug);

      expect(rows.find(({ slug }) => slug === SLUG)?.shipped).toBe(true);
      expect(rows.find(({ slug }) => slug === 'read:made_up')?.shipped).toBe(false);
      expect(rows.filter(({ shipped }) => shipped)).toHaveLength(CATALOG_MANIFEST.permissions.length);
      expect(grantOf(SystemRole.User, 'create:event')).toEqual({
        slug: 'create:event',
        managedBy: PermissionOwner.Admin,
        revokedAt: null,
        shipped: true,
      });
      expect(grantOf(SystemRole.HouseholdGuest, 'read:event_game:household')).toEqual({
        slug: 'read:event_game:household',
        managedBy: PermissionOwner.Admin,
        revokedAt: null,
        shipped: false,
      });
    });
  });

  describe('updatePermission', () => {
    beforeEach(() => stubRow());

    it('marks an edited permission as managed by the Owner in the same write, guarded by the row as it was read (#772)', async () => {
      await service.updatePermission(SLUG, { reason: 'Hosts edit their events' });

      expect(db.permission.updateMany).toHaveBeenCalledTimes(1);
      expect(db.permission.updateMany).toHaveBeenCalledWith({
        where: { id: ID, managedBy: PermissionOwner.System, updatedAt: UPDATED_AT },
        data: { reason: 'Hosts edit their events', managedBy: PermissionOwner.Admin },
      });
    });

    it("takes the permission catalog's edit lock as the transaction's first statement, so every edit's check sees the last one committed (#772)", async () => {
      const statements: string[] = [];
      db.$executeRaw.mockImplementation((async (query: unknown, ...values: unknown[]) => {
        statements.push(`${rawQueryText(query)} ${JSON.stringify(values)}`);
        return 1;
      }) as never);
      db.permission.findUnique.mockImplementation((async () => {
        statements.push('read the row');
        return { ...rowOf(snapshot, SLUG), id: ID, updatedAt: UPDATED_AT };
      }) as never);

      await service.updatePermission(SLUG, { reason: 'Hosts edit their events' });

      expect(statements[0]).toBe(
        `SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) ${JSON.stringify([CATALOG_EDIT_LOCK_NAME])}`,
      );
      expect(statements).toContain('read the row');
    });

    it("gives the edit's transaction long enough to wait out a start's reconcile holding the lock (#772)", async () => {
      // Prisma's default is five seconds, and the wait for the lock counts
      // against it: behind a start the edit would expire and answer 500.
      stubRow(SLUG);

      await service.updatePermission(SLUG, { reason: 'Hosts edit their events' });

      expect(CATALOG_EDIT_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(RECONCILE_TRANSACTION_TIMEOUT_MS);
      expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        timeout: CATALOG_EDIT_TRANSACTION_TIMEOUT_MS,
      });
    });

    it("refuses an edit of a plugin's permission with 409 CATALOG_ENTRY_NOT_EDITABLE (#772)", async () => {
      stubRow(SLUG, { managedBy: PermissionOwner.Plugin });

      const refused = service.updatePermission(SLUG, { reason: 'Mine now' });

      await expect(refused).rejects.toThrow(ConflictException);
      await expect(refused).rejects.toMatchObject({ response: { code: 'CATALOG_ENTRY_NOT_EDITABLE' } });
      expect(probe).not.toHaveBeenCalled();
      expect(db.permission.updateMany).not.toHaveBeenCalled();
    });

    it('answers the permission as edited, managed by the Owner and with its drift (#772)', async () => {
      const shipped = rowOf(snapshot, SLUG);

      const { permission } = await service.updatePermission(SLUG, { riskLevel: RiskLevel.High });

      expect(permission).toEqual(
        expect.objectContaining({
          slug: SLUG,
          riskLevel: RiskLevel.High,
          managedBy: PermissionOwner.Admin,
          retiredAt: null,
          drift: [{ field: 'riskLevel', from: RiskLevel.High, to: shipped.riskLevel }],
        }),
      );
    });

    it('answers 404 with CATALOG_ENTRY_NOT_FOUND for a slug no permission has (#772)', async () => {
      db.permission.findUnique.mockResolvedValue(null);

      const refused = service.updatePermission('read:nothing', { reason: 'x' });

      await expect(refused).rejects.toThrow(NotFoundException);
      await expect(refused).rejects.toMatchObject({ response: { code: 'CATALOG_ENTRY_NOT_FOUND' } });
      expect(db.permission.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a condition the check rejects with CATALOG_ENTRY_REFUSED and the problems (#772)', async () => {
      const rejected: EntryProblem = {
        kind: 'query-rejected',
        slug: SLUG,
        message: 'Unknown argument `hostId`.',
      };
      probe.mockResolvedValue([rejected]);
      // The shipped condition, which the guards pass, with a column Event lacks.
      const conditions = { ...(rowOf(snapshot, SLUG).conditions as Prisma.JsonObject), hostId: '{{ user.id }}' };

      const refused = service.updatePermission(SLUG, { conditions });

      await expect(refused).rejects.toBeInstanceOf(HttpException);
      await expect(refused).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        response: { code: 'CATALOG_ENTRY_REFUSED', problems: [rejected] },
      });
      expect(probe).toHaveBeenCalledWith(db, { slug: SLUG, subject: ResourceType.Event, conditions });
      expect(db.permission.updateMany).not.toHaveBeenCalled();
      expect(permissions.invalidateAllGraphs).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it("refuses with the catalog guards' problem when the edit would leave a scoped role reaching every household (#772)", async () => {
      const refused = service.updatePermission(SLUG, { conditions: {} });

      await expect(refused).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        response: {
          code: 'CATALOG_ENTRY_REFUSED',
          problems: expect.arrayContaining([expect.objectContaining({ kind: 'fails-open', slug: SLUG })]),
        },
      });
      expect(db.permission.updateMany).not.toHaveBeenCalled();
    });

    it('answers the warnings the check reports, and still writes (#772)', async () => {
      const slug = 'update:friendship:own';
      stubRow(slug);

      const { warnings } = await service.updatePermission(slug, { conditions: {} });

      expect(warnings).toContainEqual({ kind: 'unconditioned-global', slug, role: SystemRole.User });
      expect(db.permission.updateMany).toHaveBeenCalledTimes(1);
    });

    it('answers CATALOG_ENTRY_CHANGED when the row changed since it was read (#772)', async () => {
      db.permission.updateMany.mockResolvedValue({ count: 0 });

      const refused = service.updatePermission(SLUG, { reason: 'Hosts edit their events' });

      await expect(refused).rejects.toThrow(ConflictException);
      await expect(refused).rejects.toMatchObject({ response: { code: 'CATALOG_ENTRY_CHANGED' } });
      expect(permissions.invalidateAllGraphs).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('refuses a body that names nothing to change with CATALOG_EDIT_EMPTY (#772)', async () => {
      const refused = service.updatePermission(SLUG, {});

      await expect(refused).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        response: { code: 'CATALOG_EDIT_EMPTY' },
      });
      expect(db.permission.updateMany).not.toHaveBeenCalled();
    });

    it('flushes every permission graph after commit, and still answers when the flush fails (#772)', async () => {
      await service.updatePermission(SLUG, { reason: 'Hosts edit their events' });
      expect(order).toEqual(['commit', 'flush', 'emit']);

      permissions.invalidateAllGraphs.mockRejectedValue(new CacheFlushError('bge:*', 0, new Error('ECONNREFUSED')));

      await expect(service.updatePermission(SLUG, { reason: 'Hosts edit their events' })).resolves.toEqual(
        expect.objectContaining({ permission: expect.objectContaining({ slug: SLUG }) }),
      );
      expect(emitter.emit).toHaveBeenCalledTimes(2);
    });

    it('emits PermissionUpdatedEvent with before and after (#772)', async () => {
      const shipped = rowOf(snapshot, SLUG);

      await service.updatePermission(SLUG, { reason: 'Hosts edit their events', riskLevel: RiskLevel.High });

      expect(emitter.emit).toHaveBeenCalledTimes(1);
      const [name, event] = emitter.emit.mock.calls[0];
      expect(name).toBe(PermissionUpdatedEvent.eventName);
      expect(event).toBeInstanceOf(PermissionUpdatedEvent);
      expect(event).toMatchObject({
        subject: ResourceType.Permission,
        subjectId: ID,
        action: 'update',
        before: {
          slug: SLUG,
          conditions: shipped.conditions,
          reason: shipped.reason,
          riskLevel: shipped.riskLevel,
          managedBy: PermissionOwner.System,
          retiredAt: null,
        },
        after: {
          slug: SLUG,
          conditions: shipped.conditions,
          reason: 'Hosts edit their events',
          riskLevel: RiskLevel.High,
          managedBy: PermissionOwner.Admin,
          retiredAt: null,
        },
      });
    });

    describe('retiring and reviving', () => {
      it('retires a live permission with the time of the edit, without probing a condition that will run nowhere (#772)', async () => {
        const { permission } = await service.updatePermission(SLUG, { retired: true });

        const { data } = db.permission.updateMany.mock.calls[0][0] as { data: { retiredAt?: Date } };
        expect(data.retiredAt).toBeInstanceOf(Date);
        expect(permission.retiredAt).toEqual(data.retiredAt);
        expect(probe).not.toHaveBeenCalled();
      });

      it('keeps the time a retired permission was retired when its edit also retires it (#772)', async () => {
        const retiredAt = new Date('2026-10-01T00:00:00.000Z');
        snapshot = withPermission(snapshot, SLUG, { retiredAt, managedBy: PermissionOwner.Admin });
        stubRow();

        await service.updatePermission(SLUG, { retired: true, reason: 'Kept for the record' });

        const { data } = db.permission.updateMany.mock.calls[0][0] as { data: { retiredAt?: Date } };
        expect(data.retiredAt).toEqual(retiredAt);
      });

      it('probes and template-checks a condition sent with a retirement, though the permission will confer nothing (#772)', async () => {
        const conditions = { ...(rowOf(snapshot, SLUG).conditions as Prisma.JsonObject), hostId: '{{ user.id }}' };
        probe.mockResolvedValue([{ kind: 'query-rejected', slug: SLUG, message: 'Unknown argument `hostId`.' }]);

        await expect(service.updatePermission(SLUG, { retired: true, conditions })).rejects.toMatchObject({
          response: { code: 'CATALOG_ENTRY_REFUSED', problems: [expect.objectContaining({ kind: 'query-rejected' })] },
        });
        expect(probe).toHaveBeenCalledWith(db, { slug: SLUG, subject: ResourceType.Event, conditions });

        probe.mockResolvedValue([]);
        await expect(
          service.updatePermission(SLUG, { retired: true, conditions: { createdById: '{{ user.id }' } }),
        ).rejects.toMatchObject({
          response: { code: 'CATALOG_ENTRY_REFUSED', problems: [expect.objectContaining({ kind: 'template' })] },
        });
        expect(db.permission.updateMany).not.toHaveBeenCalled();
      });

      it('retires another permission, which leaves the Owner in control (#772)', async () => {
        stubRow('read:game:public');

        await service.updatePermission('read:game:public', { retired: true });

        expect(db.permission.updateMany).toHaveBeenCalledTimes(1);
      });

      it("refuses to retire the Owner's manage:all with 422 CATALOG_OWNER_LOCKOUT, and writes nothing (#772)", async () => {
        stubRow('manage:all');

        const refused = service.updatePermission('manage:all', { retired: true });

        await expect(refused).rejects.toMatchObject({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: { code: 'CATALOG_OWNER_LOCKOUT' },
        });
        expect(db.permission.updateMany).not.toHaveBeenCalled();
        expect(permissions.invalidateAllGraphs).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      it('checks a revived permission like any edit, so a condition Prisma rejects stays retired (#772)', async () => {
        snapshot = withPermission(snapshot, SLUG, {
          retiredAt: new Date('2026-10-01T00:00:00.000Z'),
          managedBy: PermissionOwner.Admin,
        });
        stubRow();
        probe.mockResolvedValue([{ kind: 'query-rejected', slug: SLUG, message: 'Unknown argument' }]);

        await expect(service.updatePermission(SLUG, { retired: false })).rejects.toMatchObject({
          response: { code: 'CATALOG_ENTRY_REFUSED' },
        });
        expect(db.permission.updateMany).not.toHaveBeenCalled();
      });

      it('clears retiredAt when a permission that passes is revived (#772)', async () => {
        snapshot = withPermission(snapshot, SLUG, {
          retiredAt: new Date('2026-10-01T00:00:00.000Z'),
          managedBy: PermissionOwner.Admin,
        });
        stubRow();

        await service.updatePermission(SLUG, { retired: false });

        expect(db.permission.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: ID, managedBy: PermissionOwner.Admin, updatedAt: UPDATED_AT },
            data: { retiredAt: null, managedBy: PermissionOwner.Admin },
          }),
        );
      });
    });

    describe('an edit that changes nothing (#772)', () => {
      const expectNothingWritten = () => {
        expect(db.permission.updateMany).not.toHaveBeenCalled();
        expect(permissions.invalidateAllGraphs).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      };

      it("answers a live permission revived with the row as it is, still the server's, and writes nothing", async () => {
        const answer = await service.updatePermission(SLUG, { retired: false });

        expect(answer).toEqual({
          permission: expect.objectContaining({
            slug: SLUG,
            managedBy: PermissionOwner.System,
            retiredAt: null,
            drift: [],
          }),
          warnings: [],
          consentDecisionsAffected: 0,
        });
        expectNothingWritten();
      });

      it('answers the current reason and risk level sent again with the row as it is', async () => {
        const { reason, riskLevel } = rowOf(snapshot, SLUG);

        await service.updatePermission(SLUG, { reason, riskLevel });

        expectNothingWritten();
      });

      it('compares conditions as JSON, so the same condition with its keys reordered changes nothing', async () => {
        const reordered = Object.fromEntries(
          Object.entries(rowOf(snapshot, SLUG).conditions as Prisma.JsonObject).reverse(),
        );

        await service.updatePermission(SLUG, { conditions: reordered });

        expectNothingWritten();
      });

      it('answers a retired permission retired again with the row as it is', async () => {
        snapshot = withPermission(snapshot, SLUG, { retiredAt: new Date('2026-10-01T00:00:00.000Z') });
        stubRow();

        await service.updatePermission(SLUG, { retired: true });

        expectNothingWritten();
      });
    });

    describe('consent decisions affected', () => {
      const serverDecision = (
        decidedRiskLevel: RiskLevel,
        plugin: { enabled: boolean; uninstalledAt: Date | null } = { enabled: true, uninstalledAt: null },
      ) => ({
        pluginId: 'plugin-1',
        scopeType: PluginGrantScope.Server,
        scopeId: '',
        decidedRiskLevel,
        status: PluginGrantStatus.Granted,
        plugin: { slug: 'tabletop-sync', version: '1.0.0', manifestJson: {}, ...plugin },
      });

      it('counts the decisions in force that the edit stops conferring, from the Granted decisions on the slug (#772)', async () => {
        db.pluginGrant.findMany.mockResolvedValue([
          serverDecision(RiskLevel.Medium),
          serverDecision(RiskLevel.Critical),
        ] as never);

        const { consentDecisionsAffected } = await service.updatePermission(SLUG, { riskLevel: RiskLevel.High });

        expect(consentDecisionsAffected).toBe(1);
        expect(db.pluginGrant.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { permissionSlug: SLUG, status: PluginGrantStatus.Granted } }),
        );
      });

      it('does not count a Granted decision of a disabled or uninstalled plugin, which confers nothing today (#772)', async () => {
        db.pluginGrant.findMany.mockResolvedValue([
          serverDecision(RiskLevel.Medium, { enabled: false, uninstalledAt: null }),
          serverDecision(RiskLevel.Medium, { enabled: true, uninstalledAt: new Date('2026-11-01T00:00:00.000Z') }),
        ] as never);

        const { consentDecisionsAffected } = await service.updatePermission(SLUG, { riskLevel: RiskLevel.High });

        expect(consentDecisionsAffected).toBe(0);
      });

      it('reads no decision for an edit of the reason alone, which no decision is judged on (#772)', async () => {
        db.pluginGrant.findMany.mockResolvedValue([serverDecision(RiskLevel.Medium)] as never);

        const { consentDecisionsAffected } = await service.updatePermission(SLUG, { reason: 'Edited on this server' });

        expect(consentDecisionsAffected).toBe(0);
        expect(db.pluginGrant.findMany).not.toHaveBeenCalled();
        expect(db.permission.updateMany).toHaveBeenCalledTimes(1);
      });

      it('still reads the decisions when the reason changes with a column they are judged on (#772)', async () => {
        db.pluginGrant.findMany.mockResolvedValue([serverDecision(RiskLevel.Medium)] as never);

        const { consentDecisionsAffected } = await service.updatePermission(SLUG, {
          reason: 'Edited on this server',
          riskLevel: RiskLevel.High,
        });

        expect(consentDecisionsAffected).toBe(1);
      });
    });
  });

  describe('editing roles and their grants (#772)', () => {
    /**
     * The role, permission and grant rows as the routes read them: whatever
     * the snapshot holds when the read runs, so a row and the snapshot never
     * disagree.
     */
    beforeEach(() => {
      db.role.findUnique.mockImplementation((async ({ where }: { where: { name: string } }) => {
        const row = snapshot.roles.find(({ name }) => name === where.name);
        return row === undefined ? null : { ...row, id: roleId(row.name), updatedAt: ROLE_UPDATED_AT };
      }) as never);
      db.permission.findUnique.mockImplementation((async ({ where }: { where: { slug: string } }) => {
        const row = snapshot.permissions.find(({ slug }) => slug === where.slug);
        return row === undefined ? null : { ...row, id: permissionId(row.slug), updatedAt: UPDATED_AT };
      }) as never);
      db.rolePermission.findUnique.mockImplementation((async ({
        where,
      }: {
        where: { roleId_permissionId: { roleId: string; permissionId: string } };
      }) => {
        const { roleId: role, permissionId: permission } = where.roleId_permissionId;
        const row = snapshot.rolePermissions.find(
          (grant) => roleId(grant.roleName) === role && permissionId(grant.permissionSlug) === permission,
        );
        return row === undefined ? null : { ...row, id: grantId(row.roleName, row.permissionSlug) };
      }) as never);
      db.role.updateMany.mockResolvedValue({ count: 1 });
      db.rolePermission.updateMany.mockResolvedValue({ count: 1 });
      db.rolePermission.deleteMany.mockResolvedValue({ count: 1 });
      db.rolePermission.createManyAndReturn.mockResolvedValue([{ id: 'grant-new' }] as never);
    });

    const expectNothingWritten = () => {
      expect(db.role.updateMany).not.toHaveBeenCalled();
      expect(db.rolePermission.createManyAndReturn).not.toHaveBeenCalled();
      expect(db.rolePermission.updateMany).not.toHaveBeenCalled();
      expect(db.rolePermission.deleteMany).not.toHaveBeenCalled();
      expect(permissions.invalidateAllGraphs).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    };

    /** Shipped to household members but not to guests, and bound to the household: a grant a guest can take. */
    const HOUSEHOLD_READ = 'read:event_game:household';

    /** A role `ROLE_SCOPE` gives no scope, such as a custom role (#1170): the entry check leaves its grants out. */
    const UNSCOPED_ROLE: RoleSnapshotRow = {
      name: 'Quartermaster',
      description: null,
      managedBy: PermissionOwner.Admin,
    };
    const withUnscopedRole = (catalog: CatalogSnapshot): CatalogSnapshot => ({
      ...catalog,
      roles: [...catalog.roles, UNSCOPED_ROLE],
    });

    it.each([
      [
        'a description',
        (s: PermissionCatalogService) => s.updateRole(SystemRole.HouseholdMember, { description: 'x' }),
      ],
      ['a grant added', (s: PermissionCatalogService) => s.addGrant(SystemRole.HouseholdGuest, HOUSEHOLD_READ)],
      ['a grant revoked', (s: PermissionCatalogService) => s.revokeGrant(SystemRole.User, 'read:game')],
      ['a role handed back', (s: PermissionCatalogService) => s.handBackRole(SystemRole.HouseholdMember)],
      ['a grant handed back', (s: PermissionCatalogService) => s.handBackGrant(SystemRole.User, 'read:game')],
    ])("takes the permission catalog's edit lock before reading anything, for %s", async (_label, edit) => {
      const statements: string[] = [];
      db.$executeRaw.mockImplementation((async (query: unknown, ...values: unknown[]) => {
        statements.push(`${rawQueryText(query)} ${JSON.stringify(values)}`);
        return 1;
      }) as never);
      const readRole = db.role.findUnique.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
      db.role.findUnique.mockImplementation((async (...args: unknown[]) => {
        statements.push('read the role');
        return readRole(...args);
      }) as never);

      await edit(service);

      expect(statements.slice(0, 2)).toEqual([
        `SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) ${JSON.stringify([CATALOG_EDIT_LOCK_NAME])}`,
        'read the role',
      ]);
    });

    describe('updateRole', () => {
      const NAME = SystemRole.HouseholdMember;

      it('marks the role as managed by the Owner in the same write as its description, guarded by the row as it was read', async () => {
        await service.updateRole(NAME, { description: 'Everyone who lives here' });

        expect(db.role.updateMany).toHaveBeenCalledTimes(1);
        expect(db.role.updateMany).toHaveBeenCalledWith({
          where: { id: roleId(NAME), managedBy: PermissionOwner.System, updatedAt: ROLE_UPDATED_AT },
          data: { description: 'Everyone who lives here', managedBy: PermissionOwner.Admin },
        });
      });

      it('answers the role as edited, with its grants and its drift from the permission catalog', async () => {
        const shipped = roleRowOf(snapshot, NAME).description;

        const role = await service.updateRole(NAME, { description: null });

        expect(role).toEqual({
          name: NAME,
          description: null,
          managedBy: PermissionOwner.Admin,
          drift: [{ field: 'description', from: null, to: shipped }],
          grants: expect.arrayContaining([
            { slug: 'read:household', managedBy: PermissionOwner.System, revokedAt: null, shipped: true },
          ]),
        });
        expect(role.grants).toHaveLength(CATALOG_MANIFEST.rolePermissions[NAME].length);
      });

      it('emits RoleUpdatedEvent with before and after, and flushes no permission graph, which holds no description', async () => {
        const shipped = roleRowOf(snapshot, NAME).description;

        await service.updateRole(NAME, { description: 'Everyone who lives here' });

        expect(order).toEqual(['commit', 'emit']);
        expect(permissions.invalidateAllGraphs).not.toHaveBeenCalled();
        const [name, event] = emitter.emit.mock.calls[0];
        expect(name).toBe(RoleUpdatedEvent.eventName);
        expect(event).toBeInstanceOf(RoleUpdatedEvent);
        expect(event).toMatchObject({
          subject: ResourceType.Role,
          subjectId: roleId(NAME),
          action: 'update',
          before: { name: NAME, description: shipped, managedBy: PermissionOwner.System },
          after: { name: NAME, description: 'Everyone who lives here', managedBy: PermissionOwner.Admin },
        });
      });

      it("answers the current description sent again with the role as it is, still the server's, and writes nothing", async () => {
        const role = await service.updateRole(NAME, { description: roleRowOf(snapshot, NAME).description });

        expect(role).toEqual(expect.objectContaining({ name: NAME, managedBy: PermissionOwner.System, drift: [] }));
        expectNothingWritten();
      });

      it('answers 404 with CATALOG_ENTRY_NOT_FOUND for a role this server does not have', async () => {
        const refused = service.updateRole('Treasurer', { description: 'x' });

        await expect(refused).rejects.toThrow(NotFoundException);
        await expect(refused).rejects.toMatchObject({ response: { code: 'CATALOG_ENTRY_NOT_FOUND' } });
        expectNothingWritten();
      });

      it("refuses a plugin's role with 409 CATALOG_ENTRY_NOT_EDITABLE", async () => {
        snapshot = withRole(snapshot, NAME, { managedBy: PermissionOwner.Plugin });

        await expect(service.updateRole(NAME, { description: 'Mine now' })).rejects.toMatchObject({
          status: HttpStatus.CONFLICT,
          response: { code: 'CATALOG_ENTRY_NOT_EDITABLE' },
        });
        expectNothingWritten();
      });

      it('answers CATALOG_ENTRY_CHANGED when the role changed since it was read', async () => {
        db.role.updateMany.mockResolvedValue({ count: 0 });

        const refused = service.updateRole(NAME, { description: 'Everyone who lives here' });

        await expect(refused).rejects.toThrow(ConflictException);
        await expect(refused).rejects.toMatchObject({ response: { code: 'CATALOG_ENTRY_CHANGED' } });
        expect(emitter.emit).not.toHaveBeenCalled();
      });
    });

    describe('addGrant', () => {
      it('creates a grant the role does not have, managed by the Owner', async () => {
        const answer = await service.addGrant(SystemRole.HouseholdGuest, HOUSEHOLD_READ);

        expect(db.rolePermission.createManyAndReturn).toHaveBeenCalledWith({
          data: [
            {
              roleId: roleId(SystemRole.HouseholdGuest),
              permissionId: permissionId(HOUSEHOLD_READ),
              managedBy: PermissionOwner.Admin,
            },
          ],
          skipDuplicates: true,
          select: { id: true },
        });
        expect(answer).toEqual({
          grant: { slug: HOUSEHOLD_READ, managedBy: PermissionOwner.Admin, revokedAt: null, shipped: false },
          warnings: [],
        });
      });

      it('re-adding a revoked grant clears revokedAt', async () => {
        snapshot = withGrant(snapshot, SystemRole.User, 'create:event', {
          managedBy: PermissionOwner.Admin,
          revokedAt: REVOKED_AT,
        });

        const { grant } = await service.addGrant(SystemRole.User, 'create:event');

        expect(db.rolePermission.updateMany).toHaveBeenCalledTimes(1);
        expect(db.rolePermission.updateMany).toHaveBeenCalledWith({
          where: {
            id: grantId(SystemRole.User, 'create:event'),
            managedBy: PermissionOwner.Admin,
            revokedAt: REVOKED_AT,
          },
          data: { revokedAt: null, managedBy: PermissionOwner.Admin },
        });
        expect(db.rolePermission.createManyAndReturn).not.toHaveBeenCalled();
        expect(grant).toEqual({
          slug: 'create:event',
          managedBy: PermissionOwner.Admin,
          revokedAt: null,
          shipped: true,
        });
      });

      it('adding update:household to HouseholdGuest answers CATALOG_ENTRY_REFUSED naming the roles its conditions name', async () => {
        const refused = service.addGrant(SystemRole.HouseholdGuest, 'update:household');

        await expect(refused).rejects.toMatchObject({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: {
            code: 'CATALOG_ENTRY_REFUSED',
            problems: [
              {
                kind: 'names-other-roles',
                slug: 'update:household',
                role: SystemRole.HouseholdGuest,
                named: [SystemRole.HouseholdOwner, SystemRole.HouseholdAdmin],
              },
            ],
          },
        });
        expectNothingWritten();
      });

      it('answers the warnings the check reports, and still writes', async () => {
        const { warnings } = await service.addGrant(SystemRole.Moderator, 'read:quota');

        expect(warnings).toEqual([{ kind: 'unconditioned-global', slug: 'read:quota', role: SystemRole.Moderator }]);
        expect(db.rolePermission.createManyAndReturn).toHaveBeenCalledTimes(1);
      });

      // The household admin's approve and revoke are both revoked; giving back
      // approve alone leaves the role able to approve an invite it cannot revoke.
      it('giving back one half of a pair warns unpaired, and still writes', async () => {
        const approve = 'update:household_invite:approve';
        for (const slug of [approve, 'update:household_invite:revoke:as-admin']) {
          snapshot = withGrant(snapshot, SystemRole.HouseholdAdmin, slug, {
            managedBy: PermissionOwner.Admin,
            revokedAt: REVOKED_AT,
          });
        }

        const { warnings } = await service.addGrant(SystemRole.HouseholdAdmin, approve);

        expect(warnings).toEqual([
          {
            kind: 'unpaired',
            slug: approve,
            role: SystemRole.HouseholdAdmin,
            partners: ['update:household_invite:revoke', 'update:household_invite:revoke:as-admin'],
          },
        ]);
        expect(db.rolePermission.updateMany).toHaveBeenCalledTimes(1);
      });

      it("answers a grant the role holds with the grant as it is, still the server's, and writes nothing", async () => {
        const answer = await service.addGrant(SystemRole.User, 'read:game');

        expect(answer).toEqual({
          grant: { slug: 'read:game', managedBy: PermissionOwner.System, revokedAt: null, shipped: true },
          warnings: [],
        });
        expectNothingWritten();
      });

      // The entry check reads live permissions only, so it could not judge the
      // grant; reviving the permission first runs the check on every holder.
      it('refuses a grant of a retired permission with 409 CATALOG_PERMISSION_RETIRED', async () => {
        snapshot = withPermission(snapshot, HOUSEHOLD_READ, {
          retiredAt: REVOKED_AT,
          managedBy: PermissionOwner.Admin,
        });

        await expect(service.addGrant(SystemRole.HouseholdGuest, HOUSEHOLD_READ)).rejects.toMatchObject({
          status: HttpStatus.CONFLICT,
          response: { code: 'CATALOG_PERMISSION_RETIRED' },
        });
        expectNothingWritten();
      });

      // The check would leave the grant out, and pass it unjudged: refused
      // until custom roles get a scope (#1170).
      it('refuses a grant to a role the entry check gives no scope with 409 CATALOG_ROLE_NOT_JUDGEABLE', async () => {
        snapshot = withUnscopedRole(snapshot);

        await expect(service.addGrant(UNSCOPED_ROLE.name, HOUSEHOLD_READ)).rejects.toMatchObject({
          status: HttpStatus.CONFLICT,
          response: { code: 'CATALOG_ROLE_NOT_JUDGEABLE' },
        });
        expectNothingWritten();
      });

      it("refuses giving a role a plugin's permission with 409 CATALOG_ENTRY_NOT_EDITABLE", async () => {
        snapshot = withPermission(snapshot, HOUSEHOLD_READ, { managedBy: PermissionOwner.Plugin });

        await expect(service.addGrant(SystemRole.HouseholdGuest, HOUSEHOLD_READ)).rejects.toMatchObject({
          status: HttpStatus.CONFLICT,
          response: { code: 'CATALOG_ENTRY_NOT_EDITABLE' },
        });
        expectNothingWritten();
      });

      it.each([
        ['role', 'Treasurer', HOUSEHOLD_READ],
        ['permission', SystemRole.HouseholdGuest, 'read:nothing'],
      ])('answers 404 with CATALOG_ENTRY_NOT_FOUND for a %s this server does not have', async (_label, role, slug) => {
        const refused = service.addGrant(role, slug);

        await expect(refused).rejects.toThrow(NotFoundException);
        await expect(refused).rejects.toMatchObject({ response: { code: 'CATALOG_ENTRY_NOT_FOUND' } });
        expectNothingWritten();
      });

      it("refuses a plugin's role, or a plugin's grant, with 409 CATALOG_ENTRY_NOT_EDITABLE", async () => {
        snapshot = withRole(snapshot, SystemRole.HouseholdGuest, { managedBy: PermissionOwner.Plugin });
        await expect(service.addGrant(SystemRole.HouseholdGuest, HOUSEHOLD_READ)).rejects.toMatchObject({
          status: HttpStatus.CONFLICT,
          response: { code: 'CATALOG_ENTRY_NOT_EDITABLE' },
        });

        snapshot = withGrant(shippedSnapshot(), SystemRole.HouseholdGuest, HOUSEHOLD_READ, {
          managedBy: PermissionOwner.Plugin,
          revokedAt: REVOKED_AT,
        });
        await expect(service.addGrant(SystemRole.HouseholdGuest, HOUSEHOLD_READ)).rejects.toMatchObject({
          status: HttpStatus.CONFLICT,
          response: { code: 'CATALOG_ENTRY_NOT_EDITABLE' },
        });
        expectNothingWritten();
      });

      it('answers CATALOG_ENTRY_CHANGED when the grant was created since it was read', async () => {
        db.rolePermission.createManyAndReturn.mockResolvedValue([] as never);

        await expect(service.addGrant(SystemRole.HouseholdGuest, HOUSEHOLD_READ)).rejects.toMatchObject({
          status: HttpStatus.CONFLICT,
          response: { code: 'CATALOG_ENTRY_CHANGED' },
        });
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      it('answers CATALOG_ENTRY_CHANGED when a revoked grant changed since it was read', async () => {
        snapshot = withGrant(snapshot, SystemRole.User, 'create:event', {
          managedBy: PermissionOwner.Admin,
          revokedAt: REVOKED_AT,
        });
        db.rolePermission.updateMany.mockResolvedValue({ count: 0 });

        await expect(service.addGrant(SystemRole.User, 'create:event')).rejects.toMatchObject({
          status: HttpStatus.CONFLICT,
          response: { code: 'CATALOG_ENTRY_CHANGED' },
        });
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      it('emits RolePermissionChangedEvent as an update, with the revoked grant as before, when it gives one back', async () => {
        snapshot = withGrant(snapshot, SystemRole.User, 'create:event', {
          managedBy: PermissionOwner.Admin,
          revokedAt: REVOKED_AT,
        });

        await service.addGrant(SystemRole.User, 'create:event');

        expect(order).toEqual(['commit', 'flush', 'emit']);
        const [name, event] = emitter.emit.mock.calls[0];
        expect(name).toBe(RolePermissionChangedEvent.eventName);
        expect(event).toMatchObject({
          subject: ResourceType.RolePermission,
          subjectId: grantId(SystemRole.User, 'create:event'),
          action: 'update',
          before: {
            roleName: SystemRole.User,
            permissionSlug: 'create:event',
            managedBy: PermissionOwner.Admin,
            revokedAt: REVOKED_AT,
          },
          after: {
            roleName: SystemRole.User,
            permissionSlug: 'create:event',
            managedBy: PermissionOwner.Admin,
            revokedAt: null,
          },
        });
      });

      it('flushes every permission graph after commit, then emits RolePermissionChangedEvent with no before for a new grant', async () => {
        await service.addGrant(SystemRole.HouseholdGuest, HOUSEHOLD_READ);

        expect(order).toEqual(['commit', 'flush', 'emit']);
        const [name, event] = emitter.emit.mock.calls[0];
        expect(name).toBe(RolePermissionChangedEvent.eventName);
        expect(event).toBeInstanceOf(RolePermissionChangedEvent);
        expect(event).toMatchObject({
          subject: ResourceType.RolePermission,
          subjectId: 'grant-new',
          action: 'create',
          before: null,
          after: {
            roleName: SystemRole.HouseholdGuest,
            permissionSlug: HOUSEHOLD_READ,
            managedBy: PermissionOwner.Admin,
            revokedAt: null,
          },
        });
      });
    });

    describe('revokeGrant', () => {
      it('revoking a grant the permission catalog lists keeps the row, revoked and managed by the Owner', async () => {
        const { grant } = await service.revokeGrant(SystemRole.User, 'read:game');

        expect(db.rolePermission.updateMany).toHaveBeenCalledTimes(1);
        expect(db.rolePermission.updateMany).toHaveBeenCalledWith({
          where: { id: grantId(SystemRole.User, 'read:game'), managedBy: PermissionOwner.System, revokedAt: null },
          data: { managedBy: PermissionOwner.Admin, revokedAt: expect.any(Date) },
        });
        expect(db.rolePermission.deleteMany).not.toHaveBeenCalled();
        expect(grant).toEqual({
          slug: 'read:game',
          managedBy: PermissionOwner.Admin,
          revokedAt: expect.any(Date),
          shipped: true,
        });
      });

      it('revoking a grant added on this server deletes it', async () => {
        snapshot = withGrant(snapshot, SystemRole.HouseholdGuest, HOUSEHOLD_READ, { managedBy: PermissionOwner.Admin });

        const { grant } = await service.revokeGrant(SystemRole.HouseholdGuest, HOUSEHOLD_READ);

        expect(db.rolePermission.deleteMany).toHaveBeenCalledTimes(1);
        expect(db.rolePermission.deleteMany).toHaveBeenCalledWith({
          where: {
            id: grantId(SystemRole.HouseholdGuest, HOUSEHOLD_READ),
            managedBy: PermissionOwner.Admin,
            revokedAt: null,
          },
        });
        expect(db.rolePermission.updateMany).not.toHaveBeenCalled();
        expect(grant).toBeNull();
      });

      it('revoking update:household_invite:revoke:as-admin from a role that keeps approve warns unpaired', async () => {
        const { warnings } = await service.revokeGrant(
          SystemRole.HouseholdAdmin,
          'update:household_invite:revoke:as-admin',
        );

        expect(warnings).toEqual([
          {
            kind: 'unpaired',
            slug: 'update:household_invite:approve',
            role: SystemRole.HouseholdAdmin,
            partners: ['update:household_invite:revoke', 'update:household_invite:revoke:as-admin'],
          },
        ]);
        expect(db.rolePermission.updateMany).toHaveBeenCalledTimes(1);
      });

      // The fail-open guard exempts a slug User holds, so taking it from User
      // can leave another role's grant of it failing open: the next start
      // would revoke that grant, so the revoke is refused now instead.
      it("refuses revoking User's grant that exempted another role's grant from the fail-open guard", async () => {
        snapshot = withGrant(snapshot, SystemRole.HouseholdGuest, 'read:platform', {
          managedBy: PermissionOwner.Admin,
        });

        const refused = service.revokeGrant(SystemRole.User, 'read:platform');

        await expect(refused).rejects.toMatchObject({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: {
            code: 'CATALOG_ENTRY_REFUSED',
            problems: [{ kind: 'fails-open', slug: 'read:platform', role: SystemRole.HouseholdGuest }],
          },
        });
        expectNothingWritten();
      });

      it("refuses revoking the Owner's manage:all with 422 CATALOG_OWNER_LOCKOUT, and writes nothing", async () => {
        await expect(service.revokeGrant(SystemRole.Owner, 'manage:all')).rejects.toMatchObject({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: { code: 'CATALOG_OWNER_LOCKOUT' },
        });
        expectNothingWritten();
      });

      it('answers a revoked grant revoked again with the grant as it is, and writes nothing', async () => {
        snapshot = withGrant(snapshot, SystemRole.User, 'create:event', {
          managedBy: PermissionOwner.Admin,
          revokedAt: REVOKED_AT,
        });

        const answer = await service.revokeGrant(SystemRole.User, 'create:event');

        expect(answer).toEqual({
          grant: { slug: 'create:event', managedBy: PermissionOwner.Admin, revokedAt: REVOKED_AT, shipped: true },
          warnings: [],
        });
        expectNothingWritten();
      });

      // Handed back but not yet restored by a start: left as it is, the next
      // start would give it back.
      it("marks a revoked grant the server manages as the Owner's, keeping when it was revoked", async () => {
        snapshot = withGrant(snapshot, SystemRole.User, 'create:event', { revokedAt: REVOKED_AT });

        await service.revokeGrant(SystemRole.User, 'create:event');

        expect(db.rolePermission.updateMany).toHaveBeenCalledWith({
          where: {
            id: grantId(SystemRole.User, 'create:event'),
            managedBy: PermissionOwner.System,
            revokedAt: REVOKED_AT,
          },
          data: { managedBy: PermissionOwner.Admin, revokedAt: REVOKED_AT },
        });
      });

      it('answers 404 with CATALOG_ENTRY_NOT_FOUND for a grant the role does not have', async () => {
        const refused = service.revokeGrant(SystemRole.HouseholdGuest, 'update:household');

        await expect(refused).rejects.toThrow(NotFoundException);
        await expect(refused).rejects.toMatchObject({ response: { code: 'CATALOG_ENTRY_NOT_FOUND' } });
        expectNothingWritten();
      });

      // Taking it only narrows what that role confers, and the role is not
      // User, so no other role's findings change (#1170).
      it('revokes a grant on a role the entry check gives no scope', async () => {
        snapshot = withGrant(withUnscopedRole(snapshot), UNSCOPED_ROLE.name, HOUSEHOLD_READ, {
          managedBy: PermissionOwner.Admin,
        });

        const { grant } = await service.revokeGrant(UNSCOPED_ROLE.name, HOUSEHOLD_READ);

        expect(db.rolePermission.deleteMany).toHaveBeenCalledWith({
          where: { id: grantId(UNSCOPED_ROLE.name, HOUSEHOLD_READ), managedBy: PermissionOwner.Admin, revokedAt: null },
        });
        expect(grant).toBeNull();
      });

      it("refuses taking a plugin's permission from a role with 409 CATALOG_ENTRY_NOT_EDITABLE", async () => {
        snapshot = withPermission(snapshot, HOUSEHOLD_READ, { managedBy: PermissionOwner.Plugin });

        await expect(service.revokeGrant(SystemRole.HouseholdMember, HOUSEHOLD_READ)).rejects.toMatchObject({
          status: HttpStatus.CONFLICT,
          response: { code: 'CATALOG_ENTRY_NOT_EDITABLE' },
        });
        expectNothingWritten();
      });

      it("refuses a plugin's grant with 409 CATALOG_ENTRY_NOT_EDITABLE", async () => {
        snapshot = withGrant(snapshot, SystemRole.HouseholdGuest, HOUSEHOLD_READ, {
          managedBy: PermissionOwner.Plugin,
        });

        await expect(service.revokeGrant(SystemRole.HouseholdGuest, HOUSEHOLD_READ)).rejects.toMatchObject({
          status: HttpStatus.CONFLICT,
          response: { code: 'CATALOG_ENTRY_NOT_EDITABLE' },
        });
        expectNothingWritten();
      });

      it('answers CATALOG_ENTRY_CHANGED when the grant changed since it was read, revoked or deleted', async () => {
        db.rolePermission.updateMany.mockResolvedValue({ count: 0 });
        await expect(service.revokeGrant(SystemRole.User, 'read:game')).rejects.toMatchObject({
          status: HttpStatus.CONFLICT,
          response: { code: 'CATALOG_ENTRY_CHANGED' },
        });

        snapshot = withGrant(snapshot, SystemRole.HouseholdGuest, HOUSEHOLD_READ, { managedBy: PermissionOwner.Admin });
        db.rolePermission.deleteMany.mockResolvedValue({ count: 0 });
        await expect(service.revokeGrant(SystemRole.HouseholdGuest, HOUSEHOLD_READ)).rejects.toMatchObject({
          status: HttpStatus.CONFLICT,
          response: { code: 'CATALOG_ENTRY_CHANGED' },
        });
        expect(permissions.invalidateAllGraphs).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      it('flushes, then emits RolePermissionChangedEvent: before and after on a revoke, no after on a delete', async () => {
        await service.revokeGrant(SystemRole.User, 'read:game');

        expect(order).toEqual(['commit', 'flush', 'emit']);
        expect(emitter.emit.mock.calls[0][1]).toMatchObject({
          subject: ResourceType.RolePermission,
          subjectId: grantId(SystemRole.User, 'read:game'),
          action: 'update',
          before: {
            roleName: SystemRole.User,
            permissionSlug: 'read:game',
            managedBy: PermissionOwner.System,
            revokedAt: null,
          },
          after: {
            roleName: SystemRole.User,
            permissionSlug: 'read:game',
            managedBy: PermissionOwner.Admin,
            revokedAt: expect.any(Date),
          },
        });

        snapshot = withGrant(snapshot, SystemRole.HouseholdGuest, HOUSEHOLD_READ, { managedBy: PermissionOwner.Admin });
        await service.revokeGrant(SystemRole.HouseholdGuest, HOUSEHOLD_READ);

        expect(emitter.emit.mock.calls[1][1]).toMatchObject({
          subjectId: grantId(SystemRole.HouseholdGuest, HOUSEHOLD_READ),
          action: 'delete',
          after: null,
        });
      });
    });

    describe('handing an entry back (#772)', () => {
      const expectHandBackOrder = () => {
        expect(order).toEqual(['commit', 'emit']);
        expect(permissions.invalidateAllGraphs).not.toHaveBeenCalled();
      };

      describe('handBackPermission', () => {
        it('hand back reports the fields the next start will restore', async () => {
          const shipped = rowOf(snapshot, SLUG);
          snapshot = withPermission(snapshot, SLUG, {
            reason: 'Edited on this server',
            riskLevel: RiskLevel.Critical,
            managedBy: PermissionOwner.Admin,
          });

          const { nextStart } = await service.handBackPermission(SLUG);

          expect(nextStart).toEqual([
            { field: 'reason', from: 'Edited on this server', to: shipped.reason },
            { field: 'riskLevel', from: RiskLevel.Critical, to: shipped.riskLevel },
          ]);
          expect(db.permission.updateMany).toHaveBeenCalledTimes(1);
          expect(db.permission.updateMany).toHaveBeenCalledWith({
            where: { id: permissionId(SLUG), managedBy: PermissionOwner.Admin, updatedAt: UPDATED_AT },
            data: { managedBy: PermissionOwner.System },
          });
          expect(emitter.emit).toHaveBeenCalledTimes(1);
          expect(emitter.emit.mock.calls[0][0]).toBe(PermissionUpdatedEvent.eventName);
          expect(emitter.emit.mock.calls[0][1]).toMatchObject({
            subjectId: permissionId(SLUG),
            before: { slug: SLUG, managedBy: PermissionOwner.Admin, reason: 'Edited on this server' },
            after: { slug: SLUG, managedBy: PermissionOwner.System, reason: 'Edited on this server' },
          });
          expectHandBackOrder();
        });

        it("waits for the edit lock as every edit does, with an edit's transaction timeout (#772)", async () => {
          snapshot = withPermission(snapshot, SLUG, { managedBy: PermissionOwner.Admin });

          await service.handBackPermission(SLUG);

          expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
            timeout: CATALOG_EDIT_TRANSACTION_TIMEOUT_MS,
          });
        });

        it('shows the revival of a retired permission the permission catalog ships as a retiredAt change', async () => {
          const retiredAt = new Date('2026-11-05T00:00:00.000Z');
          snapshot = withPermission(snapshot, SLUG, { managedBy: PermissionOwner.Admin, retiredAt });

          const { nextStart } = await service.handBackPermission(SLUG);

          expect(nextStart).toEqual([{ field: 'retiredAt', from: retiredAt, to: null }]);
        });

        it('says the next start retires a permission the permission catalog does not ship', async () => {
          snapshot = {
            ...snapshot,
            permissions: [
              ...snapshot.permissions,
              { ...rowOf(snapshot, SLUG), slug: 'read:made_up', managedBy: PermissionOwner.Admin },
            ],
          };

          const { nextStart } = await service.handBackPermission('read:made_up');

          expect(nextStart).toEqual([{ field: 'retiredAt', from: null, to: 'retired' }]);
          expect(db.permission.updateMany).toHaveBeenCalledTimes(1);
        });

        it('answers an empty list when the next start changes nothing about the permission', async () => {
          snapshot = withPermission(snapshot, SLUG, { managedBy: PermissionOwner.Admin });

          await expect(service.handBackPermission(SLUG)).resolves.toEqual({ nextStart: [] });
        });

        it('handing back an entry already marked System is a no-op answering an empty change list', async () => {
          await expect(service.handBackPermission(SLUG)).resolves.toEqual({ nextStart: [] });

          expect(db.permission.updateMany).not.toHaveBeenCalled();
          expect(emitter.emit).not.toHaveBeenCalled();
          expect(permissions.invalidateAllGraphs).not.toHaveBeenCalled();
        });

        it('answers 404 with CATALOG_ENTRY_NOT_FOUND for a slug no permission has', async () => {
          await expect(service.handBackPermission('read:nothing')).rejects.toBeInstanceOf(NotFoundException);
          await expect(service.handBackPermission('read:nothing')).rejects.toMatchObject({
            response: { code: 'CATALOG_ENTRY_NOT_FOUND' },
          });
          expect(db.permission.updateMany).not.toHaveBeenCalled();
        });

        it("refuses a plugin's permission with 409 CATALOG_ENTRY_NOT_EDITABLE, which the plugin keeps", async () => {
          snapshot = withPermission(snapshot, SLUG, { managedBy: PermissionOwner.Plugin });

          await expect(service.handBackPermission(SLUG)).rejects.toMatchObject({
            status: HttpStatus.CONFLICT,
            response: { code: 'CATALOG_ENTRY_NOT_EDITABLE' },
          });
          expect(db.permission.updateMany).not.toHaveBeenCalled();
          expect(emitter.emit).not.toHaveBeenCalled();
        });

        it('answers CATALOG_ENTRY_CHANGED, with no event or flush, when the row changed since it was read', async () => {
          snapshot = withPermission(snapshot, SLUG, { managedBy: PermissionOwner.Admin });
          db.permission.updateMany.mockResolvedValue({ count: 0 });

          await expect(service.handBackPermission(SLUG)).rejects.toMatchObject({
            status: HttpStatus.CONFLICT,
            response: { code: 'CATALOG_ENTRY_CHANGED' },
          });
          expect(emitter.emit).not.toHaveBeenCalled();
          expect(permissions.invalidateAllGraphs).not.toHaveBeenCalled();
        });
      });

      describe('handBackRole', () => {
        const description = () =>
          CATALOG_MANIFEST.roles.find(({ name }) => name === SystemRole.HouseholdMember)?.description;

        it('reports the description the next start will restore, and writes only the mark', async () => {
          snapshot = withRole(snapshot, SystemRole.HouseholdMember, {
            description: 'Edited',
            managedBy: PermissionOwner.Admin,
          });

          const { nextStart } = await service.handBackRole(SystemRole.HouseholdMember);

          expect(nextStart).toEqual([{ field: 'description', from: 'Edited', to: description() }]);
          expect(db.role.updateMany).toHaveBeenCalledWith({
            where: {
              id: roleId(SystemRole.HouseholdMember),
              managedBy: PermissionOwner.Admin,
              updatedAt: ROLE_UPDATED_AT,
            },
            data: { managedBy: PermissionOwner.System },
          });
          expect(emitter.emit.mock.calls[0][0]).toBe(RoleUpdatedEvent.eventName);
          expect(emitter.emit.mock.calls[0][1]).toMatchObject({
            before: { name: SystemRole.HouseholdMember, description: 'Edited', managedBy: PermissionOwner.Admin },
            after: { name: SystemRole.HouseholdMember, description: 'Edited', managedBy: PermissionOwner.System },
          });
          expectHandBackOrder();
        });

        it('is a no-op for a role already marked System, answering an empty change list', async () => {
          await expect(service.handBackRole(SystemRole.HouseholdMember)).resolves.toEqual({ nextStart: [] });

          expectNothingWritten();
        });

        it('answers 404 with CATALOG_ENTRY_NOT_FOUND for a role this server does not have', async () => {
          await expect(service.handBackRole('Nobody')).rejects.toMatchObject({
            status: HttpStatus.NOT_FOUND,
            response: { code: 'CATALOG_ENTRY_NOT_FOUND' },
          });
        });

        it("refuses a plugin's role with 409 CATALOG_ENTRY_NOT_EDITABLE", async () => {
          snapshot = withRole(snapshot, SystemRole.HouseholdMember, { managedBy: PermissionOwner.Plugin });

          await expect(service.handBackRole(SystemRole.HouseholdMember)).rejects.toMatchObject({
            status: HttpStatus.CONFLICT,
            response: { code: 'CATALOG_ENTRY_NOT_EDITABLE' },
          });
          expectNothingWritten();
        });

        it('answers CATALOG_ENTRY_CHANGED when the role changed since it was read', async () => {
          snapshot = withRole(snapshot, SystemRole.HouseholdMember, { managedBy: PermissionOwner.Admin });
          db.role.updateMany.mockResolvedValue({ count: 0 });

          await expect(service.handBackRole(SystemRole.HouseholdMember)).rejects.toMatchObject({
            status: HttpStatus.CONFLICT,
            response: { code: 'CATALOG_ENTRY_CHANGED' },
          });
          expect(emitter.emit).not.toHaveBeenCalled();
        });
      });

      describe('handBackGrant', () => {
        it('says the next start gives back a revoked grant the permission catalog ships', async () => {
          snapshot = withGrant(snapshot, SystemRole.User, 'read:game', {
            managedBy: PermissionOwner.Admin,
            revokedAt: REVOKED_AT,
          });

          await expect(service.handBackGrant(SystemRole.User, 'read:game')).resolves.toEqual({
            nextStart: 'grant-restored',
          });

          expect(db.rolePermission.updateMany).toHaveBeenCalledWith({
            where: {
              id: grantId(SystemRole.User, 'read:game'),
              managedBy: PermissionOwner.Admin,
              revokedAt: REVOKED_AT,
            },
            data: { managedBy: PermissionOwner.System },
          });
          expect(emitter.emit.mock.calls[0][0]).toBe(RolePermissionChangedEvent.eventName);
          expect(emitter.emit.mock.calls[0][1]).toMatchObject({
            action: 'update',
            before: { managedBy: PermissionOwner.Admin, revokedAt: REVOKED_AT },
            after: { managedBy: PermissionOwner.System, revokedAt: REVOKED_AT },
          });
          expectHandBackOrder();
        });

        it('handing back a grant the permission catalog does not list says the next start removes it', async () => {
          snapshot = withGrant(snapshot, SystemRole.HouseholdGuest, HOUSEHOLD_READ, {
            managedBy: PermissionOwner.Admin,
          });

          await expect(service.handBackGrant(SystemRole.HouseholdGuest, HOUSEHOLD_READ)).resolves.toEqual({
            nextStart: 'grant-removed',
          });

          // The grant stays until the start deletes it; the hand-back writes only the mark.
          expect(db.rolePermission.deleteMany).not.toHaveBeenCalled();
          expect(db.rolePermission.updateMany).toHaveBeenCalledWith({
            where: {
              id: grantId(SystemRole.HouseholdGuest, HOUSEHOLD_READ),
              managedBy: PermissionOwner.Admin,
              revokedAt: null,
            },
            data: { managedBy: PermissionOwner.System },
          });
        });

        it('answers an empty list for a live grant the permission catalog ships, which the start leaves as it is', async () => {
          snapshot = withGrant(snapshot, SystemRole.User, 'read:game', { managedBy: PermissionOwner.Admin });

          await expect(service.handBackGrant(SystemRole.User, 'read:game')).resolves.toEqual({ nextStart: [] });
        });

        it('is a no-op for a grant already marked System, with no event or flush', async () => {
          await expect(service.handBackGrant(SystemRole.User, 'read:game')).resolves.toEqual({ nextStart: [] });

          expectNothingWritten();
        });

        it('still says a System grant the Owner never touched but that is revoked will be given back, writing nothing', async () => {
          snapshot = withGrant(snapshot, SystemRole.User, 'read:game', { revokedAt: REVOKED_AT });

          await expect(service.handBackGrant(SystemRole.User, 'read:game')).resolves.toEqual({
            nextStart: 'grant-restored',
          });
          expectNothingWritten();
        });

        describe("a grant the Owner's other edits make fail the entry check (#772)", () => {
          /** update:household's condition, narrowed to name the household's owners alone. */
          const OWNERS_ONLY = {
            id: '{{ householdId }}',
            members: {
              some: {
                userId: '{{ user.id }}',
                role: { is: { role: { is: { name: SystemRole.HouseholdOwner } } } },
              },
            },
          };
          const WITHHELD = {
            nextStart: 'grant-withheld',
            problems: [
              expect.objectContaining({
                kind: 'names-other-roles',
                slug: 'update:household',
                role: SystemRole.HouseholdAdmin,
                named: [SystemRole.HouseholdOwner],
              }),
            ],
          };

          beforeEach(() => {
            // Revoked first, so the narrowed condition passed the edit check:
            // no live holder was left for it to name others to.
            snapshot = withPermission(snapshot, 'update:household', {
              conditions: OWNERS_ONLY,
              managedBy: PermissionOwner.Admin,
            });
          });

          it('says the next start withholds it, with why, rather than promising it back', async () => {
            snapshot = withGrant(snapshot, SystemRole.HouseholdAdmin, 'update:household', {
              managedBy: PermissionOwner.Admin,
              revokedAt: REVOKED_AT,
            });

            await expect(service.handBackGrant(SystemRole.HouseholdAdmin, 'update:household')).resolves.toEqual(
              WITHHELD,
            );

            // The hand-back itself is still written: the start judges the grant again each time.
            expect(db.rolePermission.updateMany).toHaveBeenCalledWith(
              expect.objectContaining({ data: { managedBy: PermissionOwner.System } }),
            );
            expectHandBackOrder();
          });

          it('answers the same for a System grant already handed back, writing nothing', async () => {
            snapshot = withGrant(snapshot, SystemRole.HouseholdAdmin, 'update:household', { revokedAt: REVOKED_AT });

            await expect(service.handBackGrant(SystemRole.HouseholdAdmin, 'update:household')).resolves.toEqual(
              WITHHELD,
            );
            expectNothingWritten();
          });
        });

        it('answers 404 with CATALOG_ENTRY_NOT_FOUND for a grant the role does not have', async () => {
          await expect(service.handBackGrant(SystemRole.HouseholdGuest, HOUSEHOLD_READ)).rejects.toMatchObject({
            status: HttpStatus.NOT_FOUND,
            response: { code: 'CATALOG_ENTRY_NOT_FOUND' },
          });
          expectNothingWritten();
        });

        it("refuses a plugin's grant with 409 CATALOG_ENTRY_NOT_EDITABLE", async () => {
          snapshot = withGrant(snapshot, SystemRole.User, 'read:game', { managedBy: PermissionOwner.Plugin });

          await expect(service.handBackGrant(SystemRole.User, 'read:game')).rejects.toMatchObject({
            status: HttpStatus.CONFLICT,
            response: { code: 'CATALOG_ENTRY_NOT_EDITABLE' },
          });
          expectNothingWritten();
        });

        it('answers CATALOG_ENTRY_CHANGED when the grant changed since it was read', async () => {
          snapshot = withGrant(snapshot, SystemRole.User, 'read:game', { managedBy: PermissionOwner.Admin });
          db.rolePermission.updateMany.mockResolvedValue({ count: 0 });

          await expect(service.handBackGrant(SystemRole.User, 'read:game')).rejects.toMatchObject({
            status: HttpStatus.CONFLICT,
            response: { code: 'CATALOG_ENTRY_CHANGED' },
          });
          expect(emitter.emit).not.toHaveBeenCalled();
        });
      });
    });
  });
});
