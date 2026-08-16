import {
  PluginCategory,
  PluginExecutionMode,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  Prisma,
  RiskLevel,
  type HouseholdPlugin,
  type Permission,
  type Plugin,
  type PluginGrant,
  type UserPlugin,
} from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import type { InstalledPluginDirectory } from '@boardgamesempire/plugin-contract';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { Logger } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HouseholdPluginUnitDisabledEvent,
  PluginGrantRevokedEvent,
  PluginUpdateApprovedEvent,
  PluginUpdatePendingEvent,
  PluginUpdateRejectedEvent,
  UserPluginUnitDisabledEvent,
} from '../events/plugin.events';
import type { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import type { PluginStaticAnalysisService } from '../install/plugin-static-analysis.service';
import type { StaticAnalysisFinding, StaticAnalysisReport } from '../install/static-analysis.types';
import type { PluginModuleOptions } from '../plugin-module.options';
import { PluginUpdateService, type PluginUpdateStageInput } from './plugin-update.service';
import {
  PluginUpdateAuthorityError,
  PluginUpdateBlockedByDenialError,
  PluginUpdateCriticalConfirmationError,
  PluginUpdateManifestError,
  PluginUpdateNoPendingError,
  PluginUpdatePendingConflictError,
  PluginUpdatePluginNotFoundError,
  PluginUpdateProvenanceMismatchError,
  PluginUpdateStaticAnalysisError,
  PluginUpdateTombstonedError,
  PluginUpdateUnknownCorePermissionError,
  PluginUpdateVersionConflictError,
} from './update.errors';

describe('PluginUpdateService', () => {
  const options: PluginModuleOptions = {
    pluginsRoot: '/var/lib/bge/plugins',
    bundledRoot: '/srv/bge/plugins/bundled',
    bgeVersion: '0.3.0',
    defaultLocale: 'en',
  };

  const emptyReport: StaticAnalysisReport = {
    findings: [],
    scannedFileCount: 3,
    deepScannedFileCount: 0,
    truncated: false,
  };

  const activeManifest = buildPluginManifest();

  const makePlugin = (overrides: Partial<Plugin> = {}): Plugin => ({
    id: 'plugin-1',
    slug: 'demo-sink',
    version: '1.2.0',
    category: PluginCategory.FeedbackSink,
    scope: PluginScope.Server,
    executionMode: PluginExecutionMode.InProcess,
    enabled: true,
    bundled: false,
    manifestJson: activeManifest as unknown as Prisma.JsonValue,
    config: {},
    loadFailed: false,
    loadError: null,
    installedById: null,
    installedAt: new Date(0),
    updateCheckEnabled: false,
    lastUpdateCheckAt: null,
    latestKnownVersion: null,
    latestKnownChannel: null,
    securityAdvisory: null,
    installedFromUrl: null,
    installedSha256: 'old-sha',
    registrySlug: null,
    pendingVersion: null,
    pendingManifestJson: null,
    pendingSha256: null,
    pendingSince: null,
    restartRequired: false,
    uninstalledAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  const makeGrant = (overrides: Partial<PluginGrant> = {}): PluginGrant => ({
    id: 'grant-1',
    pluginId: 'plugin-1',
    scopeType: PluginGrantScope.Server,
    scopeId: '',
    permissionSlug: 'feedback:read',
    status: PluginGrantStatus.Granted,
    decidedById: 'admin-1',
    manifestVersion: '1.2.0',
    decidedRiskLevel: RiskLevel.Medium,
    decidedAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  const makeUnit = (overrides: Partial<HouseholdPlugin> = {}): HouseholdPlugin => ({
    id: 'hp-1',
    householdId: 'household-1',
    pluginId: 'plugin-1',
    enabled: true,
    config: {},
    suspendedForConsent: false,
    suspendedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  // Carries a bounding clause so the scope-move scenarios (feedback:read
  // re-consented at household scope) stay valid under the unit-boundedness
  // gate (#60); harmless for the server-scope scenarios.
  const feedbackRead = {
    slug: 'feedback:read',
    subject: 'feedback',
    riskLevel: RiskLevel.Medium,
    conditions: { householdId: '{{ unit.householdId }}' },
  } as unknown as Permission;

  let rootDir: string;
  let db: MockDatabaseService;
  let authority: jest.Mocked<Pick<PluginGrantAuthorityService, 'isServerAdmin'>>;
  let analyzer: jest.Mocked<Pick<PluginStaticAnalysisService, 'analyze'>>;
  let emitter: { emit: jest.Mock };
  let service: PluginUpdateService;

  const directory = (bundled = false): InstalledPluginDirectory => ({
    slug: 'demo-sink',
    rootDir,
    manifestPath: join(rootDir, 'manifest.json'),
    packageJsonPath: join(rootDir, 'package.json'),
    bundled,
  });

  const writeManifest = async (manifest: PluginManifest): Promise<void> => {
    await writeFile(join(rootDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  };

  /** v1.3.0 of the fixture with no new consent surface — the immediate-activation shape. */
  const nextManifest = (overrides: Parameters<typeof buildPluginManifest>[0] = {}): PluginManifest =>
    buildPluginManifest({ version: '1.3.0', ...overrides });

  const input = (overrides: Partial<PluginUpdateStageInput> = {}): PluginUpdateStageInput => ({
    directory: directory(),
    provenance: { bundled: false, pendingSha256: 'new-sha' },
    initiatorId: 'admin-1',
    ...overrides,
  });

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'bge-update-'));
    db = createMockDatabaseService();
    authority = { isServerAdmin: jest.fn().mockResolvedValue(true) };
    analyzer = { analyze: jest.fn().mockResolvedValue(emptyReport) };
    emitter = { emit: jest.fn() };
    service = new PluginUpdateService(
      db as never,
      authority as unknown as PluginGrantAuthorityService,
      analyzer as unknown as PluginStaticAnalysisService,
      emitter as never,
      options,
    );

    db.plugin.findUnique.mockResolvedValue(makePlugin());
    db.plugin.findUniqueOrThrow.mockResolvedValue(makePlugin());
    db.permission.findMany.mockResolvedValue([feedbackRead]);
    db.pluginGrant.findMany.mockResolvedValue([
      makeGrant(),
      makeGrant({ id: 'grant-2', permissionSlug: 'plugin|demo-sink|manage:digest', decidedRiskLevel: RiskLevel.Low }),
    ]);
    db.householdPlugin.findMany.mockResolvedValue([]);
    db.userPlugin.findMany.mockResolvedValue([]);
    db.plugin.update.mockResolvedValue(makePlugin());
    // The staging write is conditional on the pending slot still being empty,
    // so it goes through updateMany rather than update.
    db.plugin.updateMany.mockResolvedValue({ count: 1 });

    db.$transaction.mockImplementation((cb) => cb(db));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  describe('stage() gates', () => {
    it('rejects a provenance/directory bundled mismatch before touching anything', async () => {
      await expect(service.stage(input({ provenance: { bundled: true } }))).rejects.toThrow(
        PluginUpdateProvenanceMismatchError,
      );
      expect(authority.isServerAdmin).not.toHaveBeenCalled();
    });

    it('requires server-admin authority', async () => {
      authority.isServerAdmin.mockResolvedValue(false);
      await writeManifest(nextManifest());

      await expect(service.stage(input())).rejects.toThrow(PluginUpdateAuthorityError);
    });

    it('rejects an unknown plugin', async () => {
      db.plugin.findUnique.mockResolvedValue(null);
      await writeManifest(nextManifest());

      await expect(service.stage(input())).rejects.toThrow(PluginUpdatePluginNotFoundError);
    });

    it('rejects a tombstoned plugin', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ uninstalledAt: new Date('2026-07-01T00:00:00Z') }));
      await writeManifest(nextManifest());

      await expect(service.stage(input())).rejects.toThrow(PluginUpdateTombstonedError);
    });

    it('refuses to stage over an existing pending update rather than discarding it', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ pendingVersion: '1.3.0', pendingSha256: 'staged-sha' }));
      await writeManifest(nextManifest({ version: '1.4.0' }));

      const failure = await service.stage(input()).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginUpdatePendingConflictError);
      expect(failure).toMatchObject({ pendingVersion: '1.3.0', incomingVersion: '1.4.0' });
      // Nothing written: the staged version stays intact for whoever is
      // looking at it, and #84 keeps its cleanup signal.
      expect(db.plugin.update).not.toHaveBeenCalled();
      expect(db.plugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('refuses an update that would change the distribution kind of the installed plugin', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ bundled: true }));
      await writeManifest(nextManifest());

      await expect(service.stage(input())).rejects.toThrow(PluginUpdateProvenanceMismatchError);
      expect(db.plugin.update).not.toHaveBeenCalled();
    });

    it('rejects a manifest whose slug does not match the installed plugin', async () => {
      await writeManifest(nextManifest({ slug: 'other-plugin' }));

      await expect(service.stage(input())).rejects.toThrow(PluginUpdateManifestError);
    });

    it('rejects the already-active version', async () => {
      await writeManifest(buildPluginManifest());

      await expect(service.stage(input())).rejects.toThrow(PluginUpdateVersionConflictError);
    });

    it('enforces bgeCompat on the NEW manifest', async () => {
      await writeManifest(nextManifest({ bgeCompat: '>=99.0.0' }));

      await expect(service.stage(input())).rejects.toThrow(PluginUpdateManifestError);
    });

    it('collects ALL missing core permissions before failing', async () => {
      db.permission.findMany.mockResolvedValue([]);
      await writeManifest(nextManifest());

      await expect(service.stage(input())).rejects.toThrow(PluginUpdateUnknownCorePermissionError);
      await expect(service.stage(input())).rejects.toMatchObject({ missingSlugs: ['feedback:read'] });
    });

    it('gates on unacknowledged forbidden imports with exact re-entry, as install does', async () => {
      const finding: StaticAnalysisFinding = {
        kind: 'esm-import',
        specifier: 'child_process',
        file: 'dist/index.js',
        severity: 'forbidden',
        scanScope: 'default',
      };
      analyzer.analyze.mockResolvedValue({ ...emptyReport, findings: [finding] });
      await writeManifest(nextManifest());

      await expect(service.stage(input())).rejects.toThrow(PluginUpdateStaticAnalysisError);
      await expect(
        service.stage(input({ acknowledgeForbiddenImports: ['child_process', 'net'] })),
      ).rejects.toMatchObject({ unexpectedSpecifiers: ['net'] });

      const staged = await service.stage(input({ acknowledgeForbiddenImports: ['child_process'] }));
      expect(staged.acknowledgedForbiddenImports).toEqual(['child_process']);
    });
  });

  describe('stage() immediate activation', () => {
    it('activates in place when nothing escalates: version promoted, restartRequired set, sha rolled forward', async () => {
      await writeManifest(nextManifest());

      const result = await service.stage(input());

      expect(result.activated).toBe(true);
      expect(result.comparison.serverGating).toBe(false);
      expect(db.plugin.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'plugin-1' },
          data: expect.objectContaining({
            version: '1.3.0',
            restartRequired: true,
            installedSha256: 'new-sha',
            pendingVersion: null,
            pendingSha256: null,
            pendingSince: null,
          }),
        }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginUpdateApprovedEvent.eventName,
        expect.any(PluginUpdateApprovedEvent),
      );
      expect(emitter.emit).not.toHaveBeenCalledWith(PluginUpdatePendingEvent.eventName, expect.anything());
    });

    it('keeps installedSha256 untouched for bundled provenance', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ bundled: true, installedSha256: null }));
      await writeManifest(nextManifest());

      await service.stage(input({ directory: directory(true), provenance: { bundled: true } }));

      const updateData = db.plugin.update.mock.calls[0][0].data as Partial<Plugin>;
      expect('installedSha256' in updateData).toBe(false);
    });

    it('applies the declares diff: added rows created Low, removed grants revoked with permission-removed', async () => {
      // v1.3.0 renames the declared permission: manage:digest → manage:archive.
      const removedGrant = makeGrant({
        id: 'grant-2',
        permissionSlug: 'plugin|demo-sink|manage:digest',
        decidedRiskLevel: RiskLevel.Low,
      });
      db.pluginGrant.findMany
        .mockResolvedValueOnce([makeGrant(), removedGrant]) // comparison load
        .mockResolvedValueOnce([removedGrant]); // grants on removed declares
      await writeManifest(
        nextManifest({
          permissions: {
            declares: ['manage:archive'],
            checks: activeManifest.permissions.checks.filter((check) => check.slug !== 'manage:digest'),
          },
        }),
      );

      const result = await service.stage(input());

      expect(result.activated).toBe(true);
      expect(db.pluginPermission.create).toHaveBeenCalledWith({
        data: { pluginId: 'plugin-1', slug: 'plugin|demo-sink|manage:archive', riskLevel: RiskLevel.Low },
      });
      expect(db.pluginGrant.deleteMany).toHaveBeenCalledWith({
        where: { pluginId: 'plugin-1', permissionSlug: { in: ['plugin|demo-sink|manage:digest'] } },
      });
      expect(db.pluginPermission.deleteMany).toHaveBeenCalledWith({
        where: { pluginId: 'plugin-1', slug: { in: ['plugin|demo-sink|manage:digest'] } },
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginGrantRevokedEvent.eventName,
        expect.objectContaining({ reason: 'permission-removed' }),
      );
    });
  });

  describe('stage() pending path', () => {
    it('stages instead of activating when a server-gating escalation exists, and emits update_pending with the escalations', async () => {
      await writeManifest(nextManifest({ storage: { ...activeManifest.storage, writesCore: ['GameNight'] } }));

      const result = await service.stage(input());

      expect(result.activated).toBe(false);
      expect(result.comparison.escalations).toEqual([{ kind: 'writes-core-added', model: 'GameNight' }]);
      // Conditional on the slot still being empty inside the transaction.
      expect(db.plugin.updateMany).toHaveBeenCalledWith({
        where: { id: 'plugin-1', pendingVersion: null },
        data: expect.objectContaining({
          pendingVersion: '1.3.0',
          pendingSha256: 'new-sha',
          pendingSince: expect.any(Date),
        }),
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginUpdatePendingEvent.eventName,
        expect.objectContaining({ escalations: result.comparison.escalations }),
      );
    });

    it('refuses when a concurrent stage claimed the pending slot first (guarded write, no silent overwrite)', async () => {
      db.plugin.updateMany.mockResolvedValue({ count: 0 });
      db.plugin.findUnique
        .mockResolvedValueOnce(makePlugin())
        .mockResolvedValueOnce(makePlugin({ pendingVersion: '1.5.0' }));
      await writeManifest(nextManifest({ storage: { ...activeManifest.storage, writesCore: ['GameNight'] } }));

      const failure = await service.stage(input()).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginUpdatePendingConflictError);
      expect(failure).toMatchObject({ pendingVersion: '1.5.0', incomingVersion: '1.3.0' });
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('forces staging when a durable denial blocks activation even with no server-gating escalation', async () => {
      db.pluginGrant.findMany.mockResolvedValue([
        makeGrant({ status: PluginGrantStatus.Denied, permissionSlug: 'feedback:read' }),
        makeGrant({ id: 'grant-2', permissionSlug: 'plugin|demo-sink|manage:digest', decidedRiskLevel: RiskLevel.Low }),
      ]);
      // feedback:read promoted to required — the denied slug becomes load-bearing.
      await writeManifest(
        nextManifest({
          permissions: {
            ...activeManifest.permissions,
            checks: activeManifest.permissions.checks.map((check) =>
              check.slug === 'feedback:read' ? { ...check, required: true } : check,
            ),
          },
        }),
      );

      const result = await service.stage(input());

      expect(result.activated).toBe(false);
      expect(result.comparison.blockedByDenial).toEqual(['feedback:read']);
    });
  });

  describe('approve()', () => {
    const pendingPlugin = (nextJson: PluginManifest, overrides: Partial<Plugin> = {}): Plugin =>
      makePlugin({
        pendingVersion: nextJson.version,
        pendingManifestJson: nextJson as unknown as Prisma.JsonValue,
        pendingSha256: 'new-sha',
        pendingSince: new Date('2026-07-29T00:00:00Z'),
        ...overrides,
      });

    it('refuses without a staged pending update', async () => {
      await expect(service.approve({ slug: 'demo-sink', approverId: 'admin-1' })).rejects.toThrow(
        PluginUpdateNoPendingError,
      );
    });

    it('re-checks the denial block at approval time', async () => {
      const next = nextManifest({
        permissions: {
          ...activeManifest.permissions,
          checks: activeManifest.permissions.checks.map((check) =>
            check.slug === 'feedback:read' ? { ...check, required: true } : check,
          ),
        },
      });
      db.plugin.findUnique.mockResolvedValue(pendingPlugin(next));
      db.pluginGrant.findMany.mockResolvedValue([makeGrant({ status: PluginGrantStatus.Denied })]);

      await expect(service.approve({ slug: 'demo-sink', approverId: 'admin-1' })).rejects.toThrow(
        PluginUpdateBlockedByDenialError,
      );
    });

    it('demands exact Critical re-entry for the NEW server checks it will grant, as install does', async () => {
      const next = nextManifest({
        permissions: {
          ...activeManifest.permissions,
          checks: [
            ...activeManifest.permissions.checks,
            {
              slug: 'user:impersonate',
              required: true,
              reason: { en: 'Acts as members.' },
              consentScope: 'server' as const,
            },
          ],
        },
      });
      db.plugin.findUnique.mockResolvedValue(pendingPlugin(next));
      db.permission.findMany.mockResolvedValue([
        feedbackRead,
        { slug: 'user:impersonate', subject: 'user', riskLevel: RiskLevel.Critical } as Permission,
      ]);
      db.pluginGrant.findMany
        .mockResolvedValueOnce([makeGrant()]) // comparison
        .mockResolvedValueOnce([makeGrant()]); // serverChecksToSeed existing rows

      await expect(service.approve({ slug: 'demo-sink', approverId: 'admin-1' })).rejects.toThrow(
        PluginUpdateCriticalConfirmationError,
      );
    });

    it('activates: seeds ONLY undecided server checks Granted, promotes pending, suspends unconsented units', async () => {
      const next = nextManifest({
        scope: 'household',
        permissions: {
          ...activeManifest.permissions,
          checks: [
            ...activeManifest.permissions.checks,
            {
              slug: 'calendar:read',
              required: true,
              reason: { en: 'Schedules digests around events.' },
              consentScope: 'household' as const,
            },
            {
              slug: 'user:impersonate',
              required: true,
              reason: { en: 'Acts as members.' },
              consentScope: 'server' as const,
            },
          ],
        },
      });
      db.plugin.findUnique.mockResolvedValue(pendingPlugin(next));
      db.permission.findMany.mockResolvedValue([
        feedbackRead,
        { slug: 'user:impersonate', subject: 'user', riskLevel: RiskLevel.Critical } as Permission,
        {
          slug: 'calendar:read',
          subject: 'calendar',
          riskLevel: RiskLevel.Low,
          conditions: { householdId: '{{ unit.householdId }}' },
        } as unknown as Permission,
      ]);
      const seeded = makeGrant({
        id: 'grant-3',
        permissionSlug: 'user:impersonate',
        decidedRiskLevel: RiskLevel.Critical,
      });
      db.pluginGrant.create.mockResolvedValue(seeded);
      // Install already seeded the v1.2.0 server checks; only the update's
      // NEW server check is undecided. The household unit has consented to
      // nothing.
      // Call order: compare() → serverChecksToSeed() → activate() household loop
      db.pluginGrant.findMany
        .mockResolvedValueOnce([
          makeGrant(),
          makeGrant({
            id: 'grant-2',
            permissionSlug: 'plugin|demo-sink|manage:digest',
            decidedRiskLevel: RiskLevel.Low,
          }),
        ]) // compare()
        .mockResolvedValueOnce([
          makeGrant(),
          makeGrant({
            id: 'grant-2',
            permissionSlug: 'plugin|demo-sink|manage:digest',
            decidedRiskLevel: RiskLevel.Low,
          }),
        ]) // serverChecksToSeed()
        .mockResolvedValueOnce([]); // activate() – household grants for the unit
      db.householdPlugin.findMany.mockResolvedValue([makeUnit()]);
      db.householdPlugin.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.approve({
        slug: 'demo-sink',
        approverId: 'admin-1',
        confirmCriticalSlugs: ['user:impersonate'],
      });

      expect(result.seededGrants).toEqual([seeded]);
      expect(db.pluginGrant.create).toHaveBeenCalledTimes(1);
      expect(db.pluginGrant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          permissionSlug: 'user:impersonate',
          scopeType: PluginGrantScope.Server,
          scopeId: '',
          status: PluginGrantStatus.Granted,
          manifestVersion: '1.3.0',
          decidedById: 'admin-1',
          decidedRiskLevel: RiskLevel.Critical,
        }),
      });
      // One write for every unit, and one grouped grant read — the query
      // count must not follow the number of households (the transaction
      // would time out and roll the whole update back).
      expect(db.householdPlugin.updateMany).toHaveBeenCalledTimes(1);
      expect(db.householdPlugin.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['hp-1'] }, suspendedForConsent: false },
        data: { suspendedForConsent: true, suspendedAt: expect.any(Date) },
      });
      expect(db.pluginGrant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            scopeType: PluginGrantScope.Household,
            scopeId: { in: ['household-1'] },
            status: PluginGrantStatus.Granted,
          }),
        }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        HouseholdPluginUnitDisabledEvent.eventName,
        expect.objectContaining({ requiredPermissionSlugs: ['calendar:read'], manifestVersion: '1.3.0' }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginUpdateApprovedEvent.eventName,
        expect.objectContaining({
          grantedPermissions: [expect.objectContaining({ slug: 'user:impersonate', consentScope: 'server' })],
        }),
      );
    });

    /**
     * A permission whose catalog risk rose since it was decided. Without
     * the re-stamp the stale baseline re-fires this escalation on every future
     * update, and the Critical second factor never sees the reclassification.
     */
    describe('risk-escalated server grant', () => {
      const escalatedPending = (): Plugin => pendingPlugin(nextManifest());

      beforeEach(() => {
        db.plugin.findUnique.mockResolvedValue(escalatedPending());
        // feedback:read was decided at Medium (makeGrant) and is Critical now.
        db.permission.findMany.mockResolvedValue([
          {
            slug: 'feedback:read',
            subject: 'feedback',
            riskLevel: RiskLevel.Critical,
            conditions: { householdId: '{{ unit.householdId }}' },
          } as unknown as Permission,
        ]);
        db.pluginGrant.findMany.mockResolvedValue([
          makeGrant(),
          makeGrant({
            id: 'grant-2',
            permissionSlug: 'plugin|demo-sink|manage:digest',
            decidedRiskLevel: RiskLevel.Low,
          }),
        ]);
        db.pluginGrant.update.mockResolvedValue(makeGrant({ decidedRiskLevel: RiskLevel.Critical }));
      });

      it('demands the Critical second factor even though nothing new is being seeded', async () => {
        const failure = await service.approve({ slug: 'demo-sink', approverId: 'admin-1' }).catch((e: unknown) => e);

        expect(failure).toBeInstanceOf(PluginUpdateCriticalConfirmationError);
        expect(failure).toMatchObject({ expectedSlugs: ['feedback:read'] });
        expect(db.pluginGrant.create).not.toHaveBeenCalled();
      });

      it('re-stamps the existing grant at the new risk, version, and approver', async () => {
        await service.approve({
          slug: 'demo-sink',
          approverId: 'admin-2',
          confirmCriticalSlugs: ['feedback:read'],
        });

        expect(db.pluginGrant.update).toHaveBeenCalledWith({
          where: {
            pluginId_scopeType_scopeId_permissionSlug: {
              pluginId: 'plugin-1',
              scopeType: PluginGrantScope.Server,
              scopeId: '',
              permissionSlug: 'feedback:read',
            },
          },
          data: {
            decidedRiskLevel: RiskLevel.Critical,
            decidedById: 'admin-2',
            decidedAt: expect.any(Date),
            manifestVersion: '1.3.0',
          },
        });
      });
    });

    /**
     * A permission moving consent scope is a different consent act, not a
     * widening: the old scope's decision authorizes nothing, and the new
     * scope needs a grant that only this approval will create.
     */
    it('seeds the new scope and revokes the stale grant when a permission moves household → server', async () => {
      const householdActive = buildPluginManifest({
        scope: 'household',
        permissions: {
          ...activeManifest.permissions,
          checks: activeManifest.permissions.checks.map((check) =>
            check.slug === 'feedback:read' ? { ...check, consentScope: 'household' as const } : check,
          ),
        },
      });
      const staleHouseholdGrant = makeGrant({
        id: 'grant-hh',
        scopeType: PluginGrantScope.Household,
        scopeId: 'household-1',
        permissionSlug: 'feedback:read',
      });
      db.plugin.findUnique.mockResolvedValue(
        pendingPlugin(nextManifest(), { manifestJson: householdActive as unknown as Prisma.JsonValue }),
      );
      const seeded = makeGrant({ id: 'grant-new', permissionSlug: 'feedback:read' });
      db.pluginGrant.create.mockResolvedValue(seeded);
      // compare() → serverChecksToSeed() → activate() stale-scope lookup
      db.pluginGrant.findMany
        .mockResolvedValueOnce([staleHouseholdGrant])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([staleHouseholdGrant]);

      const result = await service.approve({ slug: 'demo-sink', approverId: 'admin-1' });

      expect(result.comparison.escalations).toEqual([
        expect.objectContaining({ kind: 'consent-scope-changed', from: 'household', to: 'server' }),
      ]);
      expect(db.pluginGrant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ permissionSlug: 'feedback:read', scopeType: PluginGrantScope.Server }),
      });
      expect(db.pluginGrant.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['grant-hh'] } } });
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginGrantRevokedEvent.eventName,
        expect.objectContaining({ reason: 'consent-scope-changed' }),
      );
    });

    it('suspends a unit holding a STALE Granted row — presence of a grant is not consent at the new risk', async () => {
      const next = nextManifest({
        scope: 'household',
        permissions: {
          ...activeManifest.permissions,
          checks: activeManifest.permissions.checks.map((check) =>
            check.slug === 'feedback:read' ? { ...check, consentScope: 'household' as const, required: true } : check,
          ),
        },
      });
      const householdActive = buildPluginManifest({
        scope: 'household',
        permissions: {
          ...activeManifest.permissions,
          checks: activeManifest.permissions.checks.map((check) =>
            check.slug === 'feedback:read' ? { ...check, consentScope: 'household' as const, required: true } : check,
          ),
        },
      });
      // Decided at Medium, reclassified Critical: the row exists, so a
      // presence-only check would leave this unit running on stale consent.
      const staleGrant = makeGrant({
        id: 'grant-hh',
        scopeType: PluginGrantScope.Household,
        scopeId: 'household-1',
        permissionSlug: 'feedback:read',
        decidedRiskLevel: RiskLevel.Medium,
      });
      db.plugin.findUnique.mockResolvedValue(
        pendingPlugin(next, { manifestJson: householdActive as unknown as Prisma.JsonValue }),
      );
      db.permission.findMany.mockResolvedValue([
        {
          slug: 'feedback:read',
          subject: 'feedback',
          riskLevel: RiskLevel.Critical,
          conditions: { householdId: '{{ unit.householdId }}' },
        } as unknown as Permission,
      ]);
      // compare() → serverChecksToSeed() → activate() grouped household read
      db.pluginGrant.findMany
        .mockResolvedValueOnce([staleGrant])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([staleGrant]);
      db.householdPlugin.findMany.mockResolvedValue([makeUnit()]);
      db.householdPlugin.updateMany.mockResolvedValue({ count: 1 });

      await service.approve({ slug: 'demo-sink', approverId: 'admin-1' });

      expect(db.householdPlugin.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['hp-1'] }, suspendedForConsent: false },
        data: { suspendedForConsent: true, suspendedAt: expect.any(Date) },
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        HouseholdPluginUnitDisabledEvent.eventName,
        expect.objectContaining({ requiredPermissionSlugs: ['feedback:read'] }),
      );
    });

    it('emits only for units the write actually flipped when a concurrent writer takes one', async () => {
      const next = nextManifest({
        scope: 'household',
        permissions: {
          ...activeManifest.permissions,
          checks: activeManifest.permissions.checks.map((check) =>
            check.slug === 'feedback:read' ? { ...check, consentScope: 'household' as const, required: true } : check,
          ),
        },
      });
      // Active has it OPTIONAL at household scope; next promotes it to
      // required, so both units owe a fresh decision.
      const householdActive = buildPluginManifest({
        scope: 'household',
        permissions: {
          ...activeManifest.permissions,
          checks: activeManifest.permissions.checks.map((check) =>
            check.slug === 'feedback:read' ? { ...check, consentScope: 'household' as const, required: false } : check,
          ),
        },
      });
      db.plugin.findUnique.mockResolvedValue(
        pendingPlugin(next, { manifestJson: householdActive as unknown as Prisma.JsonValue }),
      );
      db.permission.findMany.mockResolvedValue([feedbackRead]);
      db.pluginGrant.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeGrant({ permissionSlug: 'plugin|demo-sink|manage:digest' })])
        .mockResolvedValueOnce([]);
      db.householdPlugin.findMany.mockResolvedValueOnce([
        makeUnit(),
        makeUnit({ id: 'hp-2', householdId: 'household-2' }),
      ]);
      // Two candidates, one write — a concurrent writer suspended hp-2 first.
      db.householdPlugin.updateMany.mockResolvedValue({ count: 1 });
      // Read-back projects `select: { id }`; the delegate mock is typed
      // against the full row, so the projection is asserted.
      db.householdPlugin.findMany.mockResolvedValueOnce([{ id: 'hp-1' } as HouseholdPlugin]);

      await service.approve({ slug: 'demo-sink', approverId: 'admin-1' });

      const suspensionEvents = emitter.emit.mock.calls.filter(
        ([name]) => name === HouseholdPluginUnitDisabledEvent.eventName,
      );
      expect(suspensionEvents).toHaveLength(1);
      expect(suspensionEvents[0][1]).toMatchObject({ after: expect.objectContaining({ id: 'hp-1' }) });
    });

    it('does NOT suspend when the recorded risk still covers the current classification', async () => {
      const householdChecks = activeManifest.permissions.checks.map((check) =>
        check.slug === 'feedback:read' ? { ...check, consentScope: 'household' as const, required: true } : check,
      );
      const next = nextManifest({
        scope: 'household',
        permissions: { ...activeManifest.permissions, checks: householdChecks },
      });
      const householdActive = buildPluginManifest({
        scope: 'household',
        permissions: { ...activeManifest.permissions, checks: householdChecks },
      });
      const coveringGrant = makeGrant({
        id: 'grant-hh',
        scopeType: PluginGrantScope.Household,
        scopeId: 'household-1',
        permissionSlug: 'feedback:read',
        decidedRiskLevel: RiskLevel.High,
      });
      db.plugin.findUnique.mockResolvedValue(
        pendingPlugin(next, { manifestJson: householdActive as unknown as Prisma.JsonValue }),
      );
      db.permission.findMany.mockResolvedValue([
        {
          slug: 'feedback:read',
          subject: 'feedback',
          riskLevel: RiskLevel.Medium,
          conditions: { householdId: '{{ unit.householdId }}' },
        } as unknown as Permission,
      ]);
      db.pluginGrant.findMany
        .mockResolvedValueOnce([coveringGrant])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([coveringGrant]);
      db.householdPlugin.findMany.mockResolvedValue([makeUnit()]);

      await service.approve({ slug: 'demo-sink', approverId: 'admin-1' });

      expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
    });

    it('leaves already-suspended units untouched (one suspension, no re-stamp)', async () => {
      const next = nextManifest({
        scope: 'household',
        permissions: {
          ...activeManifest.permissions,
          checks: [
            ...activeManifest.permissions.checks,
            {
              slug: 'calendar:read',
              required: true,
              reason: { en: 'Schedules digests around events.' },
              consentScope: 'household' as const,
            },
          ],
        },
      });
      db.plugin.findUnique.mockResolvedValue(pendingPlugin(next));
      db.permission.findMany.mockResolvedValue([
        feedbackRead,
        {
          slug: 'calendar:read',
          subject: 'calendar',
          riskLevel: RiskLevel.Low,
          conditions: { householdId: '{{ unit.householdId }}' },
        } as unknown as Permission,
      ]);
      // Call order: compare() → serverChecksToSeed() → activate() household loop
      db.pluginGrant.findMany
        .mockResolvedValueOnce([makeGrant()]) // compare()
        .mockResolvedValueOnce([makeGrant()]) // serverChecksToSeed()
        .mockResolvedValueOnce([]); // activate() – household grants for the (already-suspended) unit
      // Already-suspended units are excluded by the query itself, so the
      // suspension cannot be re-stamped or double-reported.
      db.householdPlugin.findMany.mockResolvedValue([]);

      await service.approve({ slug: 'demo-sink', approverId: 'admin-1' });

      expect(db.householdPlugin.findMany).toHaveBeenCalledWith({
        where: { pluginId: 'plugin-1', suspendedForConsent: false },
      });
      expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalledWith(HouseholdPluginUnitDisabledEvent.eventName, expect.anything());
    });
  });

  /**
   * The household pass's exact user-scope mirror (#225): same batched
   * candidate/write/read-back shape against `UserPlugin`, driven by
   * `userReconsentSlugs`. Household coverage above owns the full matrix;
   * these assert the mirrored wiring plus the two behaviors unique to the
   * scope — user escalations never server-gate, and rowless users are
   * untouched by construction.
   */
  describe('user-scope suspension (#225)', () => {
    const makeUserUnit = (overrides: Partial<UserPlugin> = {}): UserPlugin => ({
      id: 'up-1',
      userId: 'user-1',
      pluginId: 'plugin-1',
      enabled: true,
      config: {},
      suspendedForConsent: false,
      suspendedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...overrides,
    });

    // A required user check on the (server-scope) fixture is legal under
    // Narrowed by #225 — UserPlugin is the per-user enable surface
    // at any plugin scope.
    const nextWithUserCheck = (): PluginManifest =>
      nextManifest({
        permissions: {
          ...activeManifest.permissions,
          checks: [
            ...activeManifest.permissions.checks,
            {
              slug: 'read:user_digest',
              required: true,
              reason: { en: 'Reads the digest each member curated for themselves.' },
              consentScope: 'user' as const,
            },
          ],
        },
      });

    beforeEach(() => {
      db.permission.findMany.mockResolvedValue([
        feedbackRead,
        {
          slug: 'read:user_digest',
          subject: 'digest',
          riskLevel: RiskLevel.Low,
          conditions: { ownerId: '{{ unit.userId }}' },
        } as unknown as Permission,
      ]);
    });

    it('a new required user check does NOT server-gate: the update activates in place and suspends uncovered user units', async () => {
      db.userPlugin.findMany.mockResolvedValue([makeUserUnit()]);
      db.userPlugin.updateMany.mockResolvedValue({ count: 1 });
      // stage(): compare() → immediate activation (nothing server-gates, so
      // serverChecksToSeed never runs) → activate() reads user grants.
      db.pluginGrant.findMany
        .mockResolvedValueOnce([
          makeGrant(),
          makeGrant({
            id: 'grant-2',
            permissionSlug: 'plugin|demo-sink|manage:digest',
            decidedRiskLevel: RiskLevel.Low,
          }),
        ]) // compare()
        .mockResolvedValueOnce([]); // activate() – user grants for the unit
      await writeManifest(nextWithUserCheck());

      const result = await service.stage(input());

      expect(result.activated).toBe(true);
      expect(result.comparison.serverGating).toBe(false);
      expect(result.comparison.userReconsentSlugs).toEqual(['read:user_digest']);
      expect(db.userPlugin.findMany).toHaveBeenCalledWith({
        where: { pluginId: 'plugin-1', suspendedForConsent: false },
      });
      expect(db.pluginGrant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            scopeType: PluginGrantScope.User,
            scopeId: { in: ['user-1'] },
            status: PluginGrantStatus.Granted,
          }),
        }),
      );
      expect(db.userPlugin.updateMany).toHaveBeenCalledTimes(1);
      expect(db.userPlugin.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['up-1'] }, suspendedForConsent: false },
        data: { suspendedForConsent: true, suspendedAt: expect.any(Date) },
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        UserPluginUnitDisabledEvent.eventName,
        expect.objectContaining({
          requiredPermissionSlugs: ['read:user_digest'],
          manifestVersion: '1.3.0',
          after: expect.objectContaining({ userId: 'user-1', suspendedForConsent: true }),
        }),
      );
    });

    it('does not suspend a unit whose Granted row still covers the current risk — and rowless users never enter the pass', async () => {
      db.userPlugin.findMany.mockResolvedValue([makeUserUnit()]);
      db.pluginGrant.findMany
        .mockResolvedValueOnce([
          makeGrant(),
          makeGrant({
            id: 'grant-2',
            permissionSlug: 'plugin|demo-sink|manage:digest',
            decidedRiskLevel: RiskLevel.Low,
          }),
        ]) // compare()
        .mockResolvedValueOnce([
          makeGrant({
            id: 'grant-u1',
            scopeType: PluginGrantScope.User,
            scopeId: 'user-1',
            permissionSlug: 'read:user_digest',
            decidedRiskLevel: RiskLevel.Low,
          }),
        ]); // activate() – user grants for the unit
      await writeManifest(nextWithUserCheck());

      await service.stage(input());

      // The unit query is the whole universe: users with no UserPlugin row
      // never appear, so nothing rowless can be suspended by construction.
      expect(db.userPlugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalledWith(UserPluginUnitDisabledEvent.eventName, expect.anything());
    });

    it('suspends a unit holding a STALE Granted row — presence is not consent at the new risk', async () => {
      // Active AND next both request the user check; only the catalog risk
      // moved (Low → High) above the risk the user consented under.
      const shared = nextWithUserCheck();
      const activeWithUserCheck = buildPluginManifest({ permissions: { ...shared.permissions } });
      db.plugin.findUnique.mockResolvedValue(
        makePlugin({ manifestJson: activeWithUserCheck as unknown as Prisma.JsonValue }),
      );
      db.permission.findMany.mockResolvedValue([
        feedbackRead,
        {
          slug: 'read:user_digest',
          subject: 'digest',
          riskLevel: RiskLevel.High,
          conditions: { ownerId: '{{ unit.userId }}' },
        } as unknown as Permission,
      ]);
      const staleUserGrant = makeGrant({
        id: 'grant-u1',
        scopeType: PluginGrantScope.User,
        scopeId: 'user-1',
        permissionSlug: 'read:user_digest',
        decidedRiskLevel: RiskLevel.Low,
      });
      db.pluginGrant.findMany
        .mockResolvedValueOnce([makeGrant(), staleUserGrant]) // compare()
        .mockResolvedValueOnce([staleUserGrant]); // activate() – user grants
      db.userPlugin.findMany.mockResolvedValue([makeUserUnit()]);
      db.userPlugin.updateMany.mockResolvedValue({ count: 1 });
      await writeManifest(shared);

      const result = await service.stage(input());

      expect(result.comparison.userReconsentSlugs).toEqual(['read:user_digest']);
      expect(db.userPlugin.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['up-1'] }, suspendedForConsent: false },
        data: { suspendedForConsent: true, suspendedAt: expect.any(Date) },
      });
    });
  });

  describe('reject()', () => {
    it('clears the pending columns and emits update_rejected', async () => {
      db.plugin.findUnique.mockResolvedValue(
        makePlugin({ pendingVersion: '1.3.0', pendingSha256: 'new-sha', pendingSince: new Date() }),
      );

      await service.reject({ slug: 'demo-sink', rejectorId: 'admin-1' });

      expect(db.plugin.update).toHaveBeenCalledWith({
        where: { id: 'plugin-1' },
        data: { pendingVersion: null, pendingManifestJson: Prisma.DbNull, pendingSha256: null, pendingSince: null },
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginUpdateRejectedEvent.eventName,
        expect.any(PluginUpdateRejectedEvent),
      );
    });

    it('refuses without a pending update', async () => {
      await expect(service.reject({ slug: 'demo-sink', rejectorId: 'admin-1' })).rejects.toThrow(
        PluginUpdateNoPendingError,
      );
    });
  });
});
