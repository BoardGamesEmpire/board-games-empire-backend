import {
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
} from '@bge/database';
import { PermissionsService } from '@bge/permissions';
import { CacheFlushError } from '@bge/redis';
import { createTestingModuleWithDb, rawQueryText, unwrapTransaction, type MockDatabaseService } from '@bge/testing';
import { ConflictException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CATALOG_EDIT_LOCK_NAME } from './catalog-edit-lock';
import { PermissionUpdatedEvent } from './events/permission-catalog.events';
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

describe('PermissionCatalogService', () => {
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
    });
  });
});
