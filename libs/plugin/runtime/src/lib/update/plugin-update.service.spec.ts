import {
  PluginCategory,
  PluginExecutionMode,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  PluginUnitDormantReason,
  Prisma,
  RiskLevel,
  type HouseholdPlugin,
  type Permission,
  type Plugin,
  type PluginGrant,
  type UserPlugin,
} from '@bge/database';
import { uniqueViolation, uniqueViolationWithoutMeta } from '@bge/database/testing';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import type { InstalledPluginDirectory } from '@boardgamesempire/plugin-contract';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { Logger } from '@nestjs/common';
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import {
  HouseholdPluginUnitDisabledEvent,
  HouseholdPluginUnitDormantEvent,
  HouseholdPluginUnitRevivedEvent,
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

  /**
   * A row as the tx-local FOR UPDATE re-read returns it (#356): raw
   * snake_case columns off the driver, not a Prisma-shaped PluginGrant.
   */
  const lockedRow = (permissionSlug: string, status: PluginGrantStatus) => ({
    permission_slug: permissionSlug,
    status,
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
    dormantReason: null,
    dormantAt: null,
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
      new PluginConfigSchemaService(),
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
      expect(db.plugin.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // Guarded on the tombstone (an uninstall that lands mid-flight must
          // take the whole activation with it) AND on the pending slot still
          // being empty — the immediate path must not clobber a concurrently
          // staged update with its cleared columns.
          where: { id: 'plugin-1', uninstalledAt: null, pendingVersion: null, pendingSince: null },
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

    it('refuses to activate onto a row uninstalled mid-flight — the whole transaction rolls back', async () => {
      const uninstalledAt = new Date('2026-08-16T12:00:00Z');
      db.plugin.findUnique
        .mockResolvedValueOnce(makePlugin()) // the load, before the race
        .mockResolvedValue(makePlugin({ uninstalledAt })); // the guard's re-read
      db.plugin.updateMany.mockResolvedValue({ count: 0 });
      await writeManifest(nextManifest());

      const failure = await service.stage(input()).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginUpdateTombstonedError);
      expect(failure).toMatchObject({ uninstalledAt });
      // Grants seeded earlier in the same transaction go with it; committing
      // them onto a tombstone would collide with the reinstall's fresh seed.
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('applies the tx-local denial re-check on the immediate path too — same rule, same rollback', async () => {
      db.pluginGrant.findMany.mockResolvedValueOnce([]); // compare(): nothing denied, nothing escalates
      // The tx-local locking re-read sees a denial on the fixture's required
      // server check, committed after the comparison ran.
      db.$queryRaw.mockResolvedValue([lockedRow('plugin|demo-sink|manage:digest', PluginGrantStatus.Denied)]);
      await writeManifest(nextManifest());

      await expect(service.stage(input())).rejects.toThrow(PluginUpdateBlockedByDenialError);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('refuses when a concurrent stage claims the empty pending slot mid-activation, rather than clobbering it', async () => {
      db.plugin.findUnique
        .mockResolvedValueOnce(makePlugin()) // the load: no pending, nothing escalates
        .mockResolvedValue(makePlugin({ pendingVersion: '9.9.9', pendingSha256: 'other-sha' })); // the guard's re-read
      db.plugin.updateMany.mockResolvedValue({ count: 0 });
      await writeManifest(nextManifest());

      await expect(service.stage(input())).rejects.toThrow(PluginUpdatePendingConflictError);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('keeps installedSha256 untouched for bundled provenance', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ bundled: true, installedSha256: null }));
      await writeManifest(nextManifest());

      await service.stage(input({ directory: directory(true), provenance: { bundled: true } }));

      const updateData = db.plugin.updateMany.mock.calls[0][0].data as Partial<Plugin>;
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
        where: { id: 'plugin-1', pendingVersion: null, uninstalledAt: null },
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

    it('refuses to stage onto a row uninstalled mid-flight rather than re-arming the pending columns uninstall just cleared', async () => {
      const uninstalledAt = new Date('2026-08-16T12:00:00Z');
      db.plugin.updateMany.mockResolvedValue({ count: 0 });
      db.plugin.findUnique.mockResolvedValueOnce(makePlugin()).mockResolvedValue(makePlugin({ uninstalledAt }));
      await writeManifest(nextManifest({ storage: { ...activeManifest.storage, writesCore: ['GameNight'] } }));

      const failure = await service.stage(input()).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginUpdateTombstonedError);
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

    it('loses a concurrent-approve race with the typed no-pending refusal, before writing a single grant', async () => {
      // Both approves load the same staged row; the other one commits first,
      // consuming the pending state. The claim — keyed on the exact staging
      // this approval computed from (version AND the pendingSince stamp: a
      // rejected version can be re-staged under the same number, so the
      // version alone is a reusable identity), running before any other
      // write — is what turns the loser into a 409 instead of a unique-index
      // crash on the grants the winner just seeded.
      db.plugin.findUnique
        .mockResolvedValueOnce(pendingPlugin(nextManifest())) // this approve's load
        .mockResolvedValue(makePlugin()); // the guard's re-read: pending already consumed
      db.plugin.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.approve({ slug: 'demo-sink', approverId: 'admin-1' })).rejects.toThrow(
        PluginUpdateNoPendingError,
      );

      expect(db.plugin.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'plugin-1',
            uninstalledAt: null,
            pendingVersion: '1.3.0',
            pendingSince: new Date('2026-07-29T00:00:00Z'),
          },
        }),
      );
      expect(db.pluginGrant.create).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('refuses over a denial that landed after the gates but before the claim — the transaction re-checks and rolls back', async () => {
      const next = nextManifest({
        permissions: {
          ...activeManifest.permissions,
          checks: activeManifest.permissions.checks.map((check) =>
            check.slug === 'feedback:read' ? { ...check, required: true } : check,
          ),
        },
      });
      db.plugin.findUnique.mockResolvedValue(pendingPlugin(next));
      db.pluginGrant.findMany
        .mockResolvedValueOnce([]) // compare(): nothing denied yet
        .mockResolvedValueOnce([]); // serverChecksToSeed(): nothing decided yet
      // The tx-local locking re-read: a denial committed between the gates
      // and the claim. The durable-denial rule must hold at the moment of
      // activation, not the moment of the request.
      db.$queryRaw.mockResolvedValue([lockedRow('feedback:read', PluginGrantStatus.Denied)]);

      await expect(service.approve({ slug: 'demo-sink', approverId: 'admin-1' })).rejects.toThrow(
        PluginUpdateBlockedByDenialError,
      );
      expect(db.pluginGrant.create).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('refuses when a Granted row flipped to Denied between the gates and the lock — the UPDATE half no retry can see (#356)', async () => {
      const next = nextManifest({
        permissions: {
          ...activeManifest.permissions,
          checks: activeManifest.permissions.checks.map((check) =>
            check.slug === 'feedback:read' ? { ...check, required: true } : check,
          ),
        },
      });
      db.plugin.findUnique.mockResolvedValue(pendingPlugin(next));
      // Every pre-transaction read sees the Granted row: the comparison
      // passes, and the already-decided check is EXCLUDED from the seed set
      // — this transaction never writes that row, so no unique violation
      // can surface the flip and the bounded retry never fires. Only the
      // locked re-read can catch it.
      db.pluginGrant.findMany
        .mockResolvedValueOnce([makeGrant()]) // compare(): feedback:read Granted
        .mockResolvedValueOnce([makeGrant()]); // serverChecksToSeed(): already decided, nothing to seed
      // The locked re-read sees the SAME row, flipped to Denied by a
      // decide() that committed after the gates. FOR UPDATE is what
      // guarantees this ordering: the flip either commits before the lock
      // (and refuses here) or blocks on it until this transaction resolves.
      db.$queryRaw.mockResolvedValue([lockedRow('feedback:read', PluginGrantStatus.Denied)]);

      await expect(service.approve({ slug: 'demo-sink', approverId: 'admin-1' })).rejects.toThrow(
        PluginUpdateBlockedByDenialError,
      );
      expect(db.pluginGrant.create).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();

      // The re-read must be the LOCKING form — a plain snapshot cannot
      // order itself against decide()'s update, which is the whole point.
      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
      const [template, pluginId] = db.$queryRaw.mock.calls[0] as [TemplateStringsArray, string];
      const sql = template.join('?').replace(/\s+/g, ' ');
      expect(sql).toContain('FOR UPDATE');
      expect(sql).toContain('FROM plugin_grants');
      expect(sql).toContain("scope_type = 'Server'");
      expect(pluginId).toBe('plugin-1');
    });

    /**
     * Schema pin for the FOR UPDATE lock SQL (#356). `$queryRaw` is mocked
     * in this suite, so the statement never executes and an `@map`/`@@map`
     * rename on `PluginGrant` would pass every other test while breaking the
     * one transaction whose whole purpose is race-safety. The checked-in
     * Prisma model files are the only runtime-independent source of the
     * mapped names (Prisma exposes no runtime DMMF) — the household lib's
     * raw-lock spec is the precedent. This still does not show the lock
     * SERIALIZES; that needs two real concurrent transactions.
     */
    it('locks with the mapped table/column names and a real enum literal — pinned against the Prisma model files', async () => {
      const findSchemaDir = (): string => {
        let dir = __dirname;

        for (let depth = 0; depth < 10; depth += 1) {
          const candidate = join(dir, 'prisma', 'models');

          try {
            if (statSync(candidate).isDirectory()) {
              return candidate;
            }
          } catch {
            // Not this level; keep walking toward the workspace root.
          }

          dir = resolve(dir, '..');
        }

        throw new Error('Could not locate prisma/models by walking up from the spec directory');
      };

      const schemaDir = findSchemaDir();
      const grantModel = readFileSync(join(schemaDir, 'plugin', 'plugin-grant.prisma'), 'utf8');
      const scopeEnum = readFileSync(join(schemaDir, 'enums', 'plugin-grant-scope.prisma'), 'utf8');

      /** `@@map` name, or the model name when unmapped. */
      const table = /@@map\("([^"]+)"\)/.exec(grantModel)?.[1] ?? 'PluginGrant';
      /** `@map` name for one field, or the field name when unmapped. */
      const column = (field: string): string => {
        const line = new RegExp(`^\\s*${field}\\b.*$`, 'm').exec(grantModel)?.[0] ?? '';

        return /@map\("([^"]+)"\)/.exec(line)?.[1] ?? field;
      };

      const next = nextManifest({
        permissions: {
          ...activeManifest.permissions,
          checks: activeManifest.permissions.checks.map((check) =>
            check.slug === 'feedback:read' ? { ...check, required: true } : check,
          ),
        },
      });
      db.plugin.findUnique.mockResolvedValue(pendingPlugin(next));
      db.pluginGrant.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      // A denial from the locked read: the shortest path that still issues
      // the lock statement and touches nothing after it.
      db.$queryRaw.mockResolvedValue([lockedRow('feedback:read', PluginGrantStatus.Denied)]);

      await expect(service.approve({ slug: 'demo-sink', approverId: 'admin-1' })).rejects.toThrow(
        PluginUpdateBlockedByDenialError,
      );

      const [template] = db.$queryRaw.mock.calls[0] as [TemplateStringsArray];
      const sql = template.join('?').replace(/\s+/g, ' ');

      expect(sql).toContain(`FROM ${table}`);
      expect(sql).toContain(`SELECT ${column('permissionSlug')}, ${column('status')}`);
      expect(sql).toContain(`WHERE ${column('pluginId')} = ?`);
      expect(sql).toContain(`${column('scopeType')} = 'Server'`);
      // The literal must be a real value of the enum the column stores —
      // Prisma writes enum VALUES unmapped, so the source list is the pin.
      expect(scopeEnum).toMatch(/enum\s+PluginGrantScope\s*\{[^}]*\bServer\b[^}]*\}/);
      expect(sql).toContain('FOR UPDATE');
    });

    it('drops a check decided mid-flight from the seed set instead of colliding on the grant unique index', async () => {
      db.plugin.findUnique.mockResolvedValue(pendingPlugin(nextManifest()));
      const seeded = makeGrant({ id: 'grant-3', permissionSlug: 'plugin|demo-sink|manage:digest' });
      db.pluginGrant.create.mockResolvedValue(seeded);
      db.pluginGrant.findMany
        .mockResolvedValueOnce([]) // compare()
        .mockResolvedValueOnce([]); // serverChecksToSeed(): both checks undecided
      // feedback:read was decided while this approval was in flight; only
      // the still-undecided check may seed.
      db.$queryRaw.mockResolvedValue([lockedRow('feedback:read', PluginGrantStatus.Granted)]);

      const result = await service.approve({ slug: 'demo-sink', approverId: 'admin-1' });

      expect(db.pluginGrant.create).toHaveBeenCalledTimes(1);
      expect(db.pluginGrant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ permissionSlug: 'plugin|demo-sink|manage:digest' }),
      });
      expect(result.seededGrants).toEqual([seeded]);
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginUpdateApprovedEvent.eventName,
        expect.objectContaining({
          grantedPermissions: [expect.objectContaining({ slug: 'plugin|demo-sink|manage:digest' })],
        }),
      );
    });

    it('re-challenges from inside the transaction when a mid-flight decision shrinks the Critical expectation', async () => {
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
        .mockResolvedValueOnce([]) // compare()
        .mockResolvedValueOnce([]); // serverChecksToSeed(): user:impersonate undecided — expectation is [user:impersonate]
      // Decided while in flight: the seed set shrinks, so the confirmed
      // set no longer matches what this transaction grants.
      db.$queryRaw.mockResolvedValue([lockedRow('user:impersonate', PluginGrantStatus.Granted)]);

      const failure = await service
        .approve({ slug: 'demo-sink', approverId: 'admin-1', confirmCriticalSlugs: ['user:impersonate'] })
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginUpdateCriticalConfirmationError);
      expect(failure).toMatchObject({ expectedSlugs: [], receivedSlugs: ['user:impersonate'] });
      expect(db.pluginGrant.create).not.toHaveBeenCalled();
    });

    /**
     * The tx-local read is a snapshot, not a lock on absent keys: a decision
     * can commit between it and the seeding write, and the unique index is
     * what catches that. These pin the recovery — one whole retry against a
     * snapshot that can see the decision — and its bounds.
     */
    describe('a decision that commits between the tx-local read and the seeding write', () => {
      const grantCollision = () =>
        uniqueViolation({
          fields: ['plugin_id', 'scope_type', 'scope_id', 'permission_slug'],
          constraintName: 'plugin_grants_plugin_id_scope_type_scope_id_permission_slug_key',
        });

      it('retries the whole transaction, and the second snapshot drops the decided check from the seed set', async () => {
        db.plugin.findUnique.mockResolvedValue(pendingPlugin(nextManifest()));
        const seeded = makeGrant({ id: 'grant-3', permissionSlug: 'plugin|demo-sink|manage:digest' });
        db.pluginGrant.create.mockRejectedValueOnce(grantCollision()).mockResolvedValue(seeded);
        db.pluginGrant.findMany
          .mockResolvedValueOnce([]) // compare()
          .mockResolvedValueOnce([]); // serverChecksToSeed()
        db.$queryRaw
          .mockResolvedValueOnce([]) // first attempt's locked read: nothing decided, so it seeds both and loses the race
          // The retry's locked read SEES the decision the first attempt
          // collided with, so the check drops out rather than colliding again.
          .mockResolvedValueOnce([lockedRow('feedback:read', PluginGrantStatus.Granted)]);

        const result = await service.approve({ slug: 'demo-sink', approverId: 'admin-1' });

        expect(result.seededGrants).toEqual([seeded]);
        expect(db.pluginGrant.create).toHaveBeenCalledTimes(2);
        expect(db.pluginGrant.create).toHaveBeenLastCalledWith({
          data: expect.objectContaining({ permissionSlug: 'plugin|demo-sink|manage:digest' }),
        });
        // Re-claimed, not carried over: the rolled-back attempt released it.
        expect(db.plugin.updateMany).toHaveBeenCalledTimes(2);
        // One approval, one event — the abandoned attempt emits nothing,
        // because emission waits for the commit.
        expect(emitter.emit).toHaveBeenCalledTimes(1);
      });

      it('reaches the typed denial refusal when the racing decision was a durable denial', async () => {
        const next = nextManifest({
          permissions: {
            ...activeManifest.permissions,
            checks: activeManifest.permissions.checks.map((check) =>
              check.slug === 'feedback:read' ? { ...check, required: true } : check,
            ),
          },
        });
        db.plugin.findUnique.mockResolvedValue(pendingPlugin(next));
        db.pluginGrant.create.mockRejectedValueOnce(grantCollision());
        db.pluginGrant.findMany
          .mockResolvedValueOnce([]) // compare()
          .mockResolvedValueOnce([]); // serverChecksToSeed()
        db.$queryRaw
          .mockResolvedValueOnce([]) // first attempt's locked read: seeds, and collides with the denial being written
          .mockResolvedValueOnce([lockedRow('feedback:read', PluginGrantStatus.Denied)]);

        // The durable-denial rule, not a 500: what the collision was hiding
        // is a refusal the retry can finally see.
        await expect(service.approve({ slug: 'demo-sink', approverId: 'admin-1' })).rejects.toThrow(
          PluginUpdateBlockedByDenialError,
        );
        expect(db.pluginGrant.create).toHaveBeenCalledTimes(1);
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      it("retries once and no further — a second collision is the caller's answer", async () => {
        db.plugin.findUnique.mockResolvedValue(pendingPlugin(nextManifest()));
        const collision = grantCollision();
        db.pluginGrant.create.mockRejectedValue(collision);
        db.pluginGrant.findMany
          .mockResolvedValueOnce([]) // compare()
          .mockResolvedValueOnce([]); // serverChecksToSeed()
        db.$queryRaw
          .mockResolvedValueOnce([]) // first attempt's locked read
          .mockResolvedValueOnce([]); // retry: still undecided in ITS read, so it seeds and loses again

        await expect(service.approve({ slug: 'demo-sink', approverId: 'admin-1' })).rejects.toBe(collision);
        expect(db.pluginGrant.create).toHaveBeenCalledTimes(2);
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      it.each([
        [
          'a unique violation on some other constraint',
          () => uniqueViolation({ fields: ['plugin_id', 'slug'], constraintName: 'plugin_permissions_slug_key' }),
        ],
        // "Could not tell which constraint" is not "it was mine": retrying a
        // violation this transaction cannot explain would replay a
        // deterministic failure.
        ['a P2002 carrying no identifiable constraint', () => uniqueViolationWithoutMeta()],
      ])('propagates %s without retrying', async (_label, makeError) => {
        db.plugin.findUnique.mockResolvedValue(pendingPlugin(nextManifest()));
        const failure = makeError();
        db.pluginGrant.create.mockRejectedValue(failure);
        db.pluginGrant.findMany
          .mockResolvedValueOnce([]) // compare()
          .mockResolvedValueOnce([]); // serverChecksToSeed()
        db.$queryRaw.mockResolvedValue([]); // the only attempt's locked read

        await expect(service.approve({ slug: 'demo-sink', approverId: 'admin-1' })).rejects.toBe(failure);
        expect(db.pluginGrant.create).toHaveBeenCalledTimes(1);
        expect(db.plugin.updateMany).toHaveBeenCalledTimes(1);
      });
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
      db.$queryRaw.mockResolvedValue([
        lockedRow('feedback:read', PluginGrantStatus.Granted),
        lockedRow('plugin|demo-sink|manage:digest', PluginGrantStatus.Granted),
      ]); // tx-local locked server re-read: unchanged since the gates
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
      // The per-unit consequences ride the result (#321): the admin who
      // approved sees them synchronously, not only on the event stream.
      expect(result.suspendedHouseholdUnits).toEqual([{ householdId: 'household-1', outstanding: ['calendar:read'] }]);
      expect(result.suspendedUserUnits).toEqual([]);
    });

    /**
     * Activation reconciles the household rows it used to leave behind
     * (#369, D-CK–D-CP): a scope that no longer admits households makes every
     * row dormant, a scope that admits them again revives one — subject to the
     * document it still holds.
     */
    describe('household dormancy', () => {
      /** A conforming document under the fixture's schema, so config is not what is under test. */
      const conforming = { webhookUrl: 'https://example.test/hook' };

      const activateWith = async (manifest: PluginManifest): Promise<void> => {
        db.plugin.findUnique.mockResolvedValue(pendingPlugin(manifest, { scope: PluginScope.Household }));
        db.plugin.findUniqueOrThrow.mockResolvedValue(pendingPlugin(manifest, { scope: PluginScope.Household }));
        db.householdPlugin.updateMany.mockResolvedValue({ count: 1 });

        await service.approve({ slug: 'demo-sink', approverId: 'admin-1' });
      };

      it('a server-scope manifest makes every household row dormant, leaving the admin switch alone', async () => {
        db.householdPlugin.findMany.mockResolvedValue([makeUnit({ config: conforming })]);

        await activateWith(nextManifest({ scope: 'server' }));

        expect(db.householdPlugin.updateMany).toHaveBeenCalledWith({
          where: { id: { in: ['hp-1'] } },
          data: { dormantReason: PluginUnitDormantReason.ScopeOrphaned, dormantAt: expect.any(Date) },
        });
        // The row survives with the household's own intent intact — that is
        // what makes a re-scope back restore their settings rather than a
        // default (D-CK, following the uninstall tombstone's argument).
        expect(db.householdPlugin.updateMany).not.toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ enabled: false }) }),
        );
        expect(emitter.emit).toHaveBeenCalledWith(
          HouseholdPluginUnitDormantEvent.eventName,
          expect.objectContaining({
            reason: PluginUnitDormantReason.ScopeOrphaned,
            manifestVersion: '1.3.0',
            after: expect.objectContaining({ enabled: true, dormantReason: PluginUnitDormantReason.ScopeOrphaned }),
          }),
        );
      });

      it('promotes a config dormancy to scope dormancy — config cannot cure a missing surface (D-CP)', async () => {
        db.householdPlugin.findMany.mockResolvedValue([
          makeUnit({ dormantReason: PluginUnitDormantReason.NeedsConfiguration, dormantAt: new Date(0) }),
        ]);

        await activateWith(nextManifest({ scope: 'server' }));

        expect(db.householdPlugin.updateMany).toHaveBeenCalledWith({
          where: { id: { in: ['hp-1'] } },
          data: { dormantReason: PluginUnitDormantReason.ScopeOrphaned, dormantAt: expect.any(Date) },
        });
      });

      it('writes nothing for a row already dormant for scope — the pass is idempotent', async () => {
        db.householdPlugin.findMany.mockResolvedValue([
          makeUnit({ dormantReason: PluginUnitDormantReason.ScopeOrphaned, dormantAt: new Date(0) }),
        ]);

        await activateWith(nextManifest({ scope: 'server' }));

        expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalledWith(HouseholdPluginUnitDormantEvent.eventName, expect.anything());
      });

      it('revives a scope-dormant row when the manifest admits households again', async () => {
        db.householdPlugin.findMany.mockResolvedValue([
          makeUnit({
            config: conforming,
            dormantReason: PluginUnitDormantReason.ScopeOrphaned,
            dormantAt: new Date(0),
          }),
        ]);

        await activateWith(nextManifest({ scope: 'household' }));

        expect(db.householdPlugin.updateMany).toHaveBeenCalledWith({
          where: { id: { in: ['hp-1'] } },
          data: { dormantReason: null, dormantAt: null },
        });
        expect(emitter.emit).toHaveBeenCalledWith(
          HouseholdPluginUnitRevivedEvent.eventName,
          expect.objectContaining({
            clearedReason: PluginUnitDormantReason.ScopeOrphaned,
            after: expect.objectContaining({ dormantReason: null }),
          }),
        );
      });

      /**
       * D-CP's accepted cost: a single-valued reason cannot be nulled blindly.
       * Reviving this row would put it back into service holding a document the
       * manifest now in force rejects — the exact state #370 describes.
       */
      it('re-derives the config reason instead of reviving a row whose document the new schema rejects', async () => {
        db.householdPlugin.findMany.mockResolvedValue([
          makeUnit({
            config: { webhookUrl: 42 },
            dormantReason: PluginUnitDormantReason.ScopeOrphaned,
            dormantAt: new Date(0),
          }),
        ]);

        await activateWith(
          nextManifest({
            scope: 'household',
            config: {
              schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
              requiresHouseholdConfig: true,
            },
          }),
        );

        expect(db.householdPlugin.updateMany).toHaveBeenCalledWith({
          where: { id: { in: ['hp-1'] } },
          data: { dormantReason: PluginUnitDormantReason.NeedsConfiguration, dormantAt: expect.any(Date) },
        });
        expect(emitter.emit).not.toHaveBeenCalledWith(HouseholdPluginUnitRevivedEvent.eventName, expect.anything());
      });

      it('leaves a household-scope activation with no dormant rows completely alone', async () => {
        db.householdPlugin.findMany.mockResolvedValue([makeUnit({ config: conforming })]);

        await activateWith(nextManifest({ scope: 'household' }));

        expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
      });

      it('reads the rows once, whatever the household count — the transaction must not scale with installs', async () => {
        db.householdPlugin.findMany.mockResolvedValue([
          makeUnit({ config: conforming }),
          makeUnit({ id: 'hp-2', householdId: 'household-2', config: conforming }),
          makeUnit({ id: 'hp-3', householdId: 'household-3', config: conforming }),
        ]);

        await activateWith(nextManifest({ scope: 'server' }));

        expect(db.householdPlugin.findMany).toHaveBeenCalledTimes(1);
        expect(db.householdPlugin.updateMany).toHaveBeenCalledTimes(1);
        expect(db.householdPlugin.updateMany).toHaveBeenCalledWith({
          where: { id: { in: ['hp-1', 'hp-2', 'hp-3'] } },
          data: { dormantReason: PluginUnitDormantReason.ScopeOrphaned, dormantAt: expect.any(Date) },
        });
      });
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
      // (the tx-local server re-read is the locked $queryRaw, empty here).
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

    it('emits and reports only the units the write actually flipped when a concurrent writer takes one', async () => {
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
      // tx-local locked server re-read
      db.$queryRaw.mockResolvedValue([lockedRow('plugin|demo-sink|manage:digest', PluginGrantStatus.Granted)]);
      db.householdPlugin.findMany.mockResolvedValueOnce([
        makeUnit(),
        makeUnit({ id: 'hp-2', householdId: 'household-2' }),
      ]);
      // Two candidates, one write — a concurrent writer suspended hp-2 first.
      db.householdPlugin.updateMany.mockResolvedValue({ count: 1 });
      // Read-back projects `select: { id }`; the delegate mock is typed
      // against the full row, so the projection is asserted.
      db.householdPlugin.findMany.mockResolvedValueOnce([{ id: 'hp-1' } as HouseholdPlugin]);

      const result = await service.approve({ slug: 'demo-sink', approverId: 'admin-1' });

      const suspensionEvents = emitter.emit.mock.calls.filter(
        ([name]) => name === HouseholdPluginUnitDisabledEvent.eventName,
      );
      expect(suspensionEvents).toHaveLength(1);
      expect(suspensionEvents[0][1]).toMatchObject({ after: expect.objectContaining({ id: 'hp-1' }) });
      // The result reports the same post-write filtered set the events
      // describe — never the candidate list (#321).
      expect(result.suspendedHouseholdUnits).toEqual([{ householdId: 'household-1', outstanding: ['feedback:read'] }]);
      expect(result.suspendedUserUnits).toEqual([]);
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
      // tx-local locked server re-read: both server checks decided, no denial
      db.$queryRaw.mockResolvedValue([
        lockedRow('feedback:read', PluginGrantStatus.Granted),
        lockedRow('plugin|demo-sink|manage:digest', PluginGrantStatus.Granted),
      ]);
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
    it('clears the pending columns — conditionally on the exact staging the rejector saw — and emits update_rejected', async () => {
      // The staging stamp joins the version in the predicate: a rejected
      // version can be re-staged under the same number, and this clear must
      // never take a replacement staging with it.
      const stagedAt = new Date('2026-08-10T09:00:00Z');
      db.plugin.findUnique.mockResolvedValue(
        makePlugin({ pendingVersion: '1.3.0', pendingSha256: 'new-sha', pendingSince: stagedAt }),
      );

      await service.reject({ slug: 'demo-sink', rejectorId: 'admin-1' });

      expect(db.plugin.updateMany).toHaveBeenCalledWith({
        where: { id: 'plugin-1', pendingVersion: '1.3.0', pendingSince: stagedAt, uninstalledAt: null },
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

    it('refuses — with no event — when the staged update it targeted resolved or was replaced mid-flight', async () => {
      // A reject racing an approve must not report "rejected" for an update
      // that in fact activated, and racing a replacement stage it must not
      // clear a version nobody decided on. The guarded write turns both
      // races into the typed no-pending refusal.
      db.plugin.findUnique
        .mockResolvedValueOnce(makePlugin({ pendingVersion: '1.3.0', pendingSha256: 'new-sha' })) // the load
        .mockResolvedValue(makePlugin()); // the guard's re-read: still installed, pending gone
      db.plugin.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.reject({ slug: 'demo-sink', rejectorId: 'admin-1' })).rejects.toThrow(
        PluginUpdateNoPendingError,
      );
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('answers the tombstone, not no-pending, when an uninstall won the race', async () => {
      const uninstalledAt = new Date('2026-08-16T12:00:00Z');
      db.plugin.findUnique
        .mockResolvedValueOnce(makePlugin({ pendingVersion: '1.3.0', pendingSha256: 'new-sha' }))
        .mockResolvedValue(makePlugin({ uninstalledAt }));
      db.plugin.updateMany.mockResolvedValue({ count: 0 });

      const failure = await service.reject({ slug: 'demo-sink', rejectorId: 'admin-1' }).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginUpdateTombstonedError);
      expect(failure).toMatchObject({ uninstalledAt });
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  /**
   * The pending-read seam (#321): the approval screen's data source.
   * Same load/validate/compare pipeline as `approve()` — RECOMPUTED against
   * today's decisions, so the screen and the approval cannot disagree — but
   * a pure read: a denial that would make approve() throw is rendered as
   * `blockedByDenial` state instead.
   */
  describe('describePending()', () => {
    const pendingSince = new Date('2026-07-29T00:00:00Z');

    const stagedPlugin = (nextJson: PluginManifest, overrides: Partial<Plugin> = {}): Plugin =>
      makePlugin({
        pendingVersion: nextJson.version,
        pendingManifestJson: nextJson as unknown as Prisma.JsonValue,
        pendingSha256: 'new-sha',
        pendingSince,
        ...overrides,
      });

    it('throws the not-found error for an unknown slug', async () => {
      db.plugin.findUnique.mockResolvedValue(null);

      await expect(service.describePending('absent')).rejects.toThrow(PluginUpdatePluginNotFoundError);
    });

    it('throws the tombstone error for an uninstalled plugin — a 410, never a 404', async () => {
      db.plugin.findUnique.mockResolvedValue(
        stagedPlugin(nextManifest(), { uninstalledAt: new Date('2026-08-01T00:00:00Z') }),
      );

      await expect(service.describePending('demo-sink')).rejects.toThrow(PluginUpdateTombstonedError);
    });

    it('throws the no-pending error when nothing is staged', async () => {
      await expect(service.describePending('demo-sink')).rejects.toThrow(PluginUpdateNoPendingError);
    });

    it('returns the row, pendingSince, and a comparison recomputed against today, without requiring authority', async () => {
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
      db.plugin.findUnique.mockResolvedValue(stagedPlugin(next));
      db.permission.findMany.mockResolvedValue([
        feedbackRead,
        { slug: 'user:impersonate', subject: 'user', riskLevel: RiskLevel.Critical } as Permission,
      ]);

      const description = await service.describePending('demo-sink');

      expect(description.plugin.pendingVersion).toBe('1.3.0');
      expect(description.pendingSince).toEqual(pendingSince);
      expect(description.comparison.serverGating).toBe(true);
      expect(description.comparison.escalations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'new-permission', slug: 'user:impersonate', consentScope: 'server' }),
        ]),
      );
      // A read is not a consent act: the edge guards it with read:plugin,
      // and no server-admin re-verification runs here.
      expect(authority.isServerAdmin).not.toHaveBeenCalled();
      // Nothing was written or emitted — describe is a pure read.
      expect(db.plugin.update).not.toHaveBeenCalled();
      expect(db.plugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('reports the declares[] catalog diff approving would apply — the destructive half of the screen', async () => {
      // Same rename the applied-diff test stages: manage:digest → manage:archive.
      // Both paths compute it through one helper, so the screen cannot
      // promise a diff the transaction would not apply.
      db.plugin.findUnique.mockResolvedValue(
        stagedPlugin(
          nextManifest({
            permissions: {
              declares: ['manage:archive'],
              checks: activeManifest.permissions.checks.filter((check) => check.slug !== 'manage:digest'),
            },
          }),
        ),
      );

      const description = await service.describePending('demo-sink');

      expect(description.declares).toEqual({
        added: ['plugin|demo-sink|manage:archive'],
        removed: ['plugin|demo-sink|manage:digest'],
      });
    });

    it('reports an empty declares[] diff when the update leaves the catalog alone', async () => {
      db.plugin.findUnique.mockResolvedValue(stagedPlugin(nextManifest()));

      const description = await service.describePending('demo-sink');

      // Empty, not absent: a client rendering "no catalog changes" should not
      // have to distinguish an omitted field from an unchanged catalog.
      expect(description.declares).toEqual({ added: [], removed: [] });
    });

    it('renders a durable denial as blockedByDenial STATE — the read never throws the approve-time block', async () => {
      const next = nextManifest({
        permissions: {
          ...activeManifest.permissions,
          checks: activeManifest.permissions.checks.map((check) =>
            check.slug === 'feedback:read' ? { ...check, required: true } : check,
          ),
        },
      });
      db.plugin.findUnique.mockResolvedValue(stagedPlugin(next));
      db.pluginGrant.findMany.mockResolvedValue([makeGrant({ status: PluginGrantStatus.Denied })]);

      const description = await service.describePending('demo-sink');

      expect(description.comparison.blockedByDenial).toEqual(['feedback:read']);
    });

    it('enforces bgeCompat on the stored pending manifest, mirroring approve() — the 422 names the pending source', async () => {
      db.plugin.findUnique.mockResolvedValue(stagedPlugin(nextManifest({ bgeCompat: '>=99.0.0' })));

      await expect(service.describePending('demo-sink')).rejects.toMatchObject({
        name: 'PluginUpdateManifestError',
        source: 'pending',
      });
    });
  });
});
