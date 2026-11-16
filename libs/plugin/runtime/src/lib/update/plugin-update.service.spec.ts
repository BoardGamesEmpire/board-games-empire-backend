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
import { deadlock, uniqueViolation, uniqueViolationWithoutMeta } from '@bge/database/testing';
import {
  createMockDatabaseService,
  prismaColumn,
  prismaTable,
  readPrismaModels,
  UNIT_BOUND_RULES,
  type MockDatabaseService,
} from '@bge/testing';
import type { PluginArtifactDirectory } from '@boardgamesempire/plugin-contract';
import { buildPluginArtifactSha256 as sha, type PluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { Logger } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import {
  HouseholdPluginReconsentRequestedEvent,
  PluginGrantRevokedEvent,
  PluginUpdateApprovedEvent,
  PluginUpdatePendingEvent,
  PluginUpdateRejectedEvent,
  UserPluginReconsentRequestedEvent,
} from '../events/plugin.events';
import type { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import type { PluginStaticAnalysisService } from '../install/plugin-static-analysis.service';
import type { StaticAnalysisFinding, StaticAnalysisReport } from '../install/static-analysis.types';
import { PluginDirectoryLayoutError } from '../loader/loader.errors';
import { PluginDirectoryResolverService } from '../loader/plugin-directory-resolver.service';
import { buildPluginModuleOptions } from '../testing/plugin-module-options.fixture';
import { PluginUpdateService, type PluginUpdateStageInput } from './plugin-update.service';
import {
  PluginUpdateAuthorityError,
  PluginUpdateBlockedByDenialError,
  PluginUpdateCriticalConfirmationError,
  PluginUpdateDataGatewayNameConflictError,
  PluginUpdateManifestError,
  PluginUpdateNoPendingError,
  PluginUpdatePendingConflictError,
  PluginUpdatePluginNotFoundError,
  PluginUpdateStagingReplacedError,
  PluginUpdateStaticAnalysisError,
  PluginUpdateTombstonedError,
  PluginUpdateUnknownCorePermissionError,
  PluginUpdateVersionConflictError,
} from './update.errors';

describe('PluginUpdateService', () => {
  const options = buildPluginModuleOptions();

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
    pendingStagingId: null,
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

  /** The grant-lock call(s) among `db.$queryRaw`'s calls — never `mock.calls[0]`, since the plugin-config lock (D-CN) runs first. */
  const grantLockCalls = (): [TemplateStringsArray, ...unknown[]][] =>
    (db.$queryRaw.mock.calls as [TemplateStringsArray, ...unknown[]][]).filter(([template]) =>
      template.join('').includes('FROM plugin_grants'),
    );

  /**
   * The re-consent announcements activation emitted (#1149). Both scopes share
   * one routing key, so the class tells them apart, exactly as listeners do.
   */
  const householdReconsentEvents = (): HouseholdPluginReconsentRequestedEvent[] =>
    (emitter.emit.mock.calls as [string, unknown][])
      .filter(([name]) => name === HouseholdPluginReconsentRequestedEvent.eventName)
      .map(([, event]) => event)
      .filter(
        (event): event is HouseholdPluginReconsentRequestedEvent =>
          event instanceof HouseholdPluginReconsentRequestedEvent,
      );
  const userReconsentEvents = (): UserPluginReconsentRequestedEvent[] =>
    (emitter.emit.mock.calls as [string, unknown][])
      .filter(([name]) => name === UserPluginReconsentRequestedEvent.eventName)
      .map(([, event]) => event)
      .filter(
        (event): event is UserPluginReconsentRequestedEvent => event instanceof UserPluginReconsentRequestedEvent,
      );

  const makeGrant = (overrides: Partial<PluginGrant> = {}): PluginGrant => ({
    id: 'grant-1',
    pluginId: 'plugin-1',
    scopeType: PluginGrantScope.Server,
    scopeId: '',
    permissionSlug: 'feedback:read',
    status: PluginGrantStatus.Granted,
    decidedById: 'admin-1',
    actId: null,
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
    ...UNIT_BOUND_RULES.Household,
    riskLevel: RiskLevel.Medium,
  } as unknown as Permission;

  let rootDir: string;
  let db: MockDatabaseService;
  let authority: jest.Mocked<Pick<PluginGrantAuthorityService, 'isServerAdmin'>>;
  let analyzer: jest.Mocked<Pick<PluginStaticAnalysisService, 'analyze'>>;
  let directories: { confirm: jest.Mock };
  let emitter: { emit: jest.Mock };
  let service: PluginUpdateService;
  /**
   * Queues one grant-lock answer (FIFO — one entry per activation attempt
   * a test drives). `$queryRaw` now also carries the plugin-config lock
   * (D-CN), routed separately by table name in `beforeEach` below, so a
   * test's grant-lock sequence is never disturbed by the plugin-config
   * lock's calls interleaved ahead of it.
   */
  let queueGrantLock: (rows: readonly ReturnType<typeof lockedRow>[]) => void;
  /** The row the plugin-config lock (D-CN) answers with — defaults to an empty retained config. */
  let setPluginConfigLock: (config: unknown) => void;
  /** The category that locked read finds on the plugin's row (#1083). Defaults to the fixture plugin's. */
  let setLockedCategory: (category: PluginCategory) => void;

  const directory = (): PluginArtifactDirectory => ({
    slug: 'demo-sink',
    sha256: sha('b'),
    rootDir,
    manifestPath: join(rootDir, 'manifest.json'),
    packageJsonPath: join(rootDir, 'package.json'),
  });

  const writeManifest = async (manifest: PluginManifest): Promise<void> => {
    await writeFile(join(rootDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  };

  /** v1.3.0 of the fixture with no new consent surface — the immediate-activation shape. */
  const nextManifest = (overrides: Parameters<typeof buildPluginManifest>[0] = {}): PluginManifest =>
    buildPluginManifest({ version: '1.3.0', ...overrides });

  const input = (overrides: Partial<PluginUpdateStageInput> = {}): PluginUpdateStageInput => ({
    directory: directory(),
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
    directories = { confirm: jest.fn((dir: PluginArtifactDirectory) => Promise.resolve(dir)) };
    emitter = { emit: jest.fn() };
    service = new PluginUpdateService(
      db as never,
      authority as unknown as PluginGrantAuthorityService,
      analyzer as unknown as PluginStaticAnalysisService,
      new PluginConfigSchemaService(),
      emitter as never,
      options,
      // The resolver's own spec covers the layout; here it confirms whatever
      // directory the case hands over.
      directories as unknown as PluginDirectoryResolverService,
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

    // Routes `$queryRaw` by table name: the plugin-config lock (D-CN)
    // answers with `pluginConfigLockRow` (settable per test, defaults to an
    // empty retained config), and the grant lock draws from a FIFO queue —
    // one entry per activation attempt a test drives — falling back to
    // "nothing locked" (today's default) once the queue is empty.
    const grantLockQueue: (readonly ReturnType<typeof lockedRow>[])[] = [];
    let pluginConfigLockRow: { config: unknown; category: PluginCategory } = {
      config: {},
      category: PluginCategory.FeedbackSink,
    };

    queueGrantLock = (rows) => grantLockQueue.push(rows);
    setPluginConfigLock = (config) => {
      pluginConfigLockRow = { ...pluginConfigLockRow, config };
    };
    setLockedCategory = (category) => {
      pluginConfigLockRow = { ...pluginConfigLockRow, category };
    };

    db.$queryRaw.mockImplementation(((strings: TemplateStringsArray) => {
      const sql = strings.join('');

      if (sql.includes('FROM plugin_grants')) {
        return Promise.resolve(grantLockQueue.shift() ?? []);
      }

      if (sql.includes('FROM plugins')) {
        return Promise.resolve([pluginConfigLockRow]);
      }

      // A third raw query landing here by default would get the config
      // lock's row shape regardless of what it actually asked for, and the
      // test driving it would pass or fail for the wrong reason.
      throw new Error(`Unrouted $queryRaw in test: ${sql}`);
    }) as never);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  describe('stage() gates', () => {
    it('refuses a directory the loader could not resolve at the next boot, and records nothing (#224)', async () => {
      directories.confirm.mockRejectedValue(new PluginDirectoryLayoutError('demo-sink', 'checksum fails the pattern'));
      await writeManifest(nextManifest());

      await expect(
        service.stage(
          input({
            directory: {
              ...directory(),
              sha256: `sha256:${'A'.repeat(64)}` as unknown as PluginArtifactSha256,
            },
          }),
        ),
      ).rejects.toBeInstanceOf(PluginDirectoryLayoutError);
      expect(db.plugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
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
      // looking at it.
      expect(db.plugin.update).not.toHaveBeenCalled();
      expect(db.plugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
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
          where: { id: 'plugin-1', uninstalledAt: null, pendingVersion: null, pendingStagingId: null },
          data: expect.objectContaining({
            version: '1.3.0',
            restartRequired: true,
            installedSha256: 'b'.repeat(64),
            pendingVersion: null,
            pendingSha256: null,
            pendingSince: null,
            pendingStagingId: null,
          }),
        }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginUpdateApprovedEvent.eventName,
        expect.any(PluginUpdateApprovedEvent),
      );
      expect(emitter.emit).not.toHaveBeenCalledWith(PluginUpdatePendingEvent.eventName, expect.anything());
    });

    it("an update that activates at once records the artifact directory's checksum (#224)", async () => {
      await writeManifest(nextManifest());

      const result = await service.stage(input({ directory: { ...directory(), sha256: sha('d') } }));

      expect(result.activated).toBe(true);
      expect(db.plugin.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ installedSha256: 'd'.repeat(64) }) }),
      );
    });

    // installedAt names the install, and an update keeps it: the copy of the
    // plugin already running still counts as this install's, so its
    // DataGateway keeps being routed until a restart loads the new version.
    // A reinstall writes a new one (#1083).
    it("an update's activation leaves installedAt alone, so the running copy still counts as this install's (#1083)", async () => {
      await writeManifest(nextManifest());

      const result = await service.stage(input());

      expect(result.activated).toBe(true);
      const [claim] = db.plugin.updateMany.mock.calls[0];
      expect(claim.data).toMatchObject({ version: '1.3.0' });
      expect(claim.data).not.toHaveProperty('installedAt');
    });

    // A version may move a plugin to another category. Its DataGateway row
    // follows a move into or out of data-gateway, as it follows an install
    // and an uninstall, and stays untouched by every other update (#1083).
    describe('a plugin an update moves into or out of the data-gateway category (#1083)', () => {
      /** A data-gateway plugin, as the load and the locked read in the transaction both find it. */
      const dataGatewayPlugin = (): Plugin => {
        setLockedCategory(PluginCategory.DataGateway);

        return makePlugin({ category: PluginCategory.DataGateway });
      };

      it('creates the DataGateway row when the update makes it a data-gateway plugin, named and attributed as an install would', async () => {
        db.dataGateway.updateMany.mockResolvedValue({ count: 0 });
        db.dataGateway.findUnique.mockResolvedValue(null);
        await writeManifest(nextManifest({ category: 'data-gateway' }));

        const result = await service.stage(input());

        expect(result.activated).toBe(true);
        expect(db.dataGateway.create).toHaveBeenCalledWith({
          data: { name: 'Demo Sink', pluginId: 'plugin-1', enabled: true, createdById: 'admin-1' },
        });
        // Under the claim: the plugin row is this transaction's before the row's foreign key locks it.
        expect(db.plugin.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
          db.dataGateway.create.mock.invocationCallOrder[0],
        );
      });

      it('enables the row the plugin kept from an earlier time in the category, and creates none', async () => {
        db.dataGateway.updateMany.mockResolvedValue({ count: 1 });
        await writeManifest(nextManifest({ category: 'data-gateway' }));

        await service.stage(input());

        expect(db.dataGateway.updateMany).toHaveBeenCalledWith({
          where: { pluginId: 'plugin-1' },
          data: { enabled: true },
        });
        expect(db.dataGateway.create).not.toHaveBeenCalled();
      });

      it('disables the row and keeps it when the update moves the plugin to another category', async () => {
        db.plugin.findUnique.mockResolvedValue(dataGatewayPlugin());
        db.dataGateway.updateMany.mockResolvedValue({ count: 1 });
        await writeManifest(nextManifest({ category: 'feedback-sink' }));

        const result = await service.stage(input());

        expect(result.activated).toBe(true);
        expect(db.dataGateway.updateMany).toHaveBeenCalledTimes(1);
        expect(db.dataGateway.updateMany).toHaveBeenCalledWith({
          where: { pluginId: 'plugin-1' },
          data: { enabled: false },
        });
        expect(db.dataGateway.create).not.toHaveBeenCalled();
        expect(db.dataGateway.delete).not.toHaveBeenCalled();
        expect(db.dataGateway.deleteMany).not.toHaveBeenCalled();
      });

      // A row an admin disabled must not come back enabled with the plugin's next version.
      it.each<[string, () => Plugin, PluginManifest['category']]>([
        ['stays a data-gateway plugin', dataGatewayPlugin, 'data-gateway'],
        ['stays in another category', () => makePlugin(), 'feedback-sink'],
      ])('touches no DataGateway row when the plugin %s', async (_case, plugin, category) => {
        db.plugin.findUnique.mockResolvedValue(plugin());
        await writeManifest(nextManifest({ category }));

        const result = await service.stage(input());

        expect(result.activated).toBe(true);
        expect(db.dataGateway.updateMany).not.toHaveBeenCalled();
        expect(db.dataGateway.create).not.toHaveBeenCalled();
      });

      // With nothing staged, the claim doesn't pin the category, so another
      // activation can move the plugin between this one's load and its lock.
      it('goes by the category read under the lock, not the one loaded before it', async () => {
        // Loaded as a data-gateway plugin, and moved out since: the row was disabled then.
        db.plugin.findUnique.mockResolvedValue(makePlugin({ category: PluginCategory.DataGateway }));
        setLockedCategory(PluginCategory.FeedbackSink);
        db.dataGateway.updateMany.mockResolvedValue({ count: 1 });
        await writeManifest(nextManifest({ category: 'data-gateway' }));

        await service.stage(input());

        // Back into the category, so the kept row is enabled again. By the load, nothing would have moved.
        expect(db.dataGateway.updateMany).toHaveBeenCalledWith({
          where: { pluginId: 'plugin-1' },
          data: { enabled: true },
        });
      });

      it("refuses with the update's own conflict when another DataGateway holds the name, from inside the transaction", async () => {
        db.dataGateway.updateMany.mockResolvedValue({ count: 0 });
        db.dataGateway.findUnique.mockResolvedValue({ id: 'gw-other' } as never);
        await writeManifest(nextManifest({ category: 'data-gateway' }));

        const failure = await service.stage(input()).catch((err: unknown) => err);

        expect(failure).toBeInstanceOf(PluginUpdateDataGatewayNameConflictError);
        expect(failure).toMatchObject({ slug: 'demo-sink', dataGatewayName: 'Demo Sink' });
        // Thrown inside the transaction's callback, so the claim goes back with it.
        expect(db.$transaction).toHaveBeenCalledTimes(1);
        expect(db.dataGateway.create).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalledWith(PluginUpdateApprovedEvent.eventName, expect.anything());
      });
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
      queueGrantLock([lockedRow('plugin|demo-sink|manage:digest', PluginGrantStatus.Denied)]);
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
      // The dropped declaration is also a dropped requested permission; it
      // revokes once, under the declares diff, never a second time (#577).
      expect(db.pluginGrant.deleteMany).toHaveBeenCalledTimes(1);
      expect(emitter.emit).not.toHaveBeenCalledWith(
        PluginGrantRevokedEvent.eventName,
        expect.objectContaining({ reason: 'permission-no-longer-requested' }),
      );
    });

    it('deletes every decision on a core permission the next manifest stops requesting, granted and denied, with permission-no-longer-requested (#577)', async () => {
      // v1.3.0 stops requesting feedback:read and leaves declares[] alone.
      // Both decisions go: a decision on a permission nothing requests must
      // not confer if a later version requests it again (#577).
      const granted = makeGrant();
      const denied = makeGrant({
        id: 'grant-hh',
        scopeType: PluginGrantScope.Household,
        scopeId: 'household-1',
        status: PluginGrantStatus.Denied,
      });
      db.pluginGrant.findMany
        .mockResolvedValueOnce([granted, denied]) // comparison load
        .mockResolvedValueOnce([granted, denied]); // decisions on permissions no longer requested
      await writeManifest(
        nextManifest({
          permissions: {
            ...activeManifest.permissions,
            checks: activeManifest.permissions.checks.filter((check) => check.slug !== 'feedback:read'),
          },
        }),
      );

      const result = await service.stage(input());

      expect(result.activated).toBe(true);
      expect(db.pluginGrant.deleteMany).toHaveBeenCalledWith({
        where: { pluginId: 'plugin-1', permissionSlug: { in: ['feedback:read'] } },
      });
      expect(db.pluginPermission.deleteMany).not.toHaveBeenCalled();
      const revocations = emitter.emit.mock.calls.filter(
        ([eventName]) => eventName === PluginGrantRevokedEvent.eventName,
      );
      expect(revocations.map(([, event]) => (event as PluginGrantRevokedEvent).reason)).toEqual([
        'permission-no-longer-requested',
        'permission-no-longer-requested',
      ]);
    });

    it("names the version a revoked household decision's act answered, not the one the update replaces (#1150)", async () => {
      // Consent given at 1.0.0 survived the unchanged 1.2.0. Its revocation
      // names 1.0.0, read from its act; a server decision has no act until
      // #1152 and names the outgoing 1.2.0.
      const server = makeGrant();
      const household = makeGrant({
        id: 'grant-hh',
        scopeType: PluginGrantScope.Household,
        scopeId: 'household-1',
        actId: 'act-hh',
      });
      db.pluginGrant.findMany
        .mockResolvedValueOnce([server, household]) // comparison load
        .mockResolvedValueOnce([server, household]); // decisions on permissions no longer requested
      db.pluginConsentAct.findMany.mockResolvedValue([{ id: 'act-hh', manifestVersion: '1.0.0' }] as never);
      await writeManifest(
        nextManifest({
          permissions: {
            ...activeManifest.permissions,
            checks: activeManifest.permissions.checks.filter((check) => check.slug !== 'feedback:read'),
          },
        }),
      );

      await service.stage(input());

      expect(db.pluginConsentAct.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['act-hh'] } },
        select: { id: true, manifestVersion: true },
      });
      const contexts = emitter.emit.mock.calls
        .filter(([eventName]) => eventName === PluginGrantRevokedEvent.eventName)
        .map(([, event]) => (event as PluginGrantRevokedEvent).context);
      expect(contexts).toEqual([
        { manifestVersion: '1.2.0', actId: null },
        { manifestVersion: '1.0.0', actId: 'act-hh' },
      ]);
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
          pendingSha256: 'b'.repeat(64),
          pendingSince: expect.any(Date),
        }),
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginUpdatePendingEvent.eventName,
        expect.objectContaining({ escalations: result.comparison.escalations }),
      );
    });

    it('stage writes a fresh staging id (#357)', async () => {
      // The id is the staging's identity in both guarded writes, so it must
      // differ between two stagings of the same version from the same bytes.
      await writeManifest(nextManifest({ storage: { ...activeManifest.storage, writesCore: ['GameNight'] } }));

      await service.stage(input());
      await service.stage(input());

      const stagingIds = (db.plugin.updateMany.mock.calls as [{ data: { pendingStagingId?: unknown } }][]).map(
        ([args]) => args.data.pendingStagingId,
      );
      expect(stagingIds).toHaveLength(2);
      expect(stagingIds[0]).toMatch(/^[a-z0-9]{24}$/);
      expect(stagingIds[1]).toMatch(/^[a-z0-9]{24}$/);
      expect(stagingIds[0]).not.toBe(stagingIds[1]);
    });

    it("stages the artifact directory's checksum as pendingSha256 (#224)", async () => {
      // The staged update's files are the directory its pendingSha256 names,
      // so the checksum comes from that directory and from nowhere else.
      await writeManifest(nextManifest({ storage: { ...activeManifest.storage, writesCore: ['GameNight'] } }));

      await service.stage(input({ directory: { ...directory(), sha256: sha('d') } }));

      expect(db.plugin.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ pendingSha256: 'd'.repeat(64) }) }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginUpdatePendingEvent.eventName,
        expect.objectContaining({ pendingSha256: 'd'.repeat(64) }),
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
        pendingSha256: 'f'.repeat(64),
        pendingSince: new Date('2026-07-29T00:00:00Z'),
        pendingStagingId: 'staging-a',
        ...overrides,
      });

    it('refuses without a staged pending update', async () => {
      await expect(
        service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' }),
      ).rejects.toThrow(PluginUpdateNoPendingError);
    });

    it('activation claims only the staging it loaded, by its staging id (#357)', async () => {
      // A staging's timestamp is not an identity: two stagings can share a
      // millisecond, and a clock can step back onto an old one. The id can't
      // repeat, so the claim names it and nothing else.
      db.plugin.findUnique.mockResolvedValue(pendingPlugin(nextManifest()));

      await service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' });

      const [claim] = db.plugin.updateMany.mock.calls[0];
      expect(claim.where).toEqual({
        id: 'plugin-1',
        uninstalledAt: null,
        pendingVersion: '1.3.0',
        pendingStagingId: 'staging-a',
      });
    });

    it('approval records the staged checksum as installedSha256 (#224)', async () => {
      // Activation switches which artifact directory the row names: the
      // staged artifact becomes the installed one, and nothing on disk moves.
      db.plugin.findUnique.mockResolvedValue(pendingPlugin(nextManifest(), { pendingSha256: 'e'.repeat(64) }));

      await service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' });

      expect(db.plugin.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ installedSha256: 'e'.repeat(64) }) }),
      );
    });

    it('approve refuses a staging id that is not the current staging, and writes nothing (#357)', async () => {
      // The admin approved what the staged-update read showed them. If that
      // staging was rejected and another staged since — even the same version
      // from the same artifact — approving it would consent to something they
      // never reviewed.
      db.plugin.findUnique.mockResolvedValue(pendingPlugin(nextManifest(), { pendingStagingId: 'staging-b' }));

      const failure = await service
        .approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' })
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginUpdateStagingReplacedError);
      expect(failure).toMatchObject({ slug: 'demo-sink', stagingId: 'staging-a' });
      expect(db.plugin.updateMany).not.toHaveBeenCalled();
      expect(db.pluginGrant.create).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('approve answers a replaced staging when another one takes the slot between its check and its claim (#357)', async () => {
      db.plugin.findUnique
        .mockResolvedValueOnce(pendingPlugin(nextManifest())) // this approve's load: staging-a
        .mockResolvedValue(pendingPlugin(nextManifest(), { pendingStagingId: 'staging-b' })); // the claim's re-read
      db.plugin.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' }),
      ).rejects.toThrow(PluginUpdateStagingReplacedError);
      expect(db.pluginGrant.create).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('refuses to approve a staged row whose checksum is not a checksum (#1117)', async () => {
      // The staged checksum becomes a path segment at activation; a corrupt
      // value is refused as the resolver refuses it at the next boot.
      db.plugin.findUnique.mockResolvedValue(pendingPlugin(nextManifest(), { pendingSha256: 'not-a-checksum' }));

      await expect(
        service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' }),
      ).rejects.toThrow(PluginDirectoryLayoutError);
      expect(db.plugin.update).not.toHaveBeenCalled();
      expect(db.plugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('refuses a corrupt staged checksum before it validates the staged manifest or reads a permission (#1117)', async () => {
      // A staged manifest that fails validation too: the checksum is judged
      // first, so the refusal names it, and no escalation work runs.
      db.plugin.findUnique.mockResolvedValue(
        pendingPlugin(nextManifest(), {
          pendingSha256: 'not-a-checksum',
          pendingManifestJson: { slug: 'demo-sink' } as unknown as Prisma.JsonValue,
        }),
      );

      await expect(
        service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' }),
      ).rejects.toThrow(PluginDirectoryLayoutError);
      expect(db.permission.findMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('refuses to approve a staged row with no checksum (#696)', async () => {
      // Every staging names a plugin artifact, so a staged row without its
      // checksum is not an update anyone can activate: activation would have
      // no artifact to record.
      db.plugin.findUnique.mockResolvedValue(pendingPlugin(nextManifest(), { pendingSha256: null }));

      await expect(
        service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' }),
      ).rejects.toThrow(PluginUpdateNoPendingError);
      expect(db.plugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('loses a concurrent-approve race with the typed no-pending refusal, before writing a single grant', async () => {
      // Both approves load the same staged row; the other one commits first,
      // consuming the pending state. The claim — keyed on the exact staging
      // this approval computed from (version AND staging id: a rejected
      // version can be re-staged under the same number, so the version alone
      // is a reusable identity), running before any other write — is what
      // turns the loser into a 409 instead of a unique-index crash on the
      // grants the winner just seeded.
      db.plugin.findUnique
        .mockResolvedValueOnce(pendingPlugin(nextManifest())) // this approve's load
        .mockResolvedValue(makePlugin()); // the guard's re-read: pending already consumed
      db.plugin.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' }),
      ).rejects.toThrow(PluginUpdateNoPendingError);

      expect(db.plugin.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'plugin-1',
            uninstalledAt: null,
            pendingVersion: '1.3.0',
            pendingStagingId: 'staging-a',
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
      queueGrantLock([lockedRow('feedback:read', PluginGrantStatus.Denied)]);

      await expect(
        service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' }),
      ).rejects.toThrow(PluginUpdateBlockedByDenialError);
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
      queueGrantLock([lockedRow('feedback:read', PluginGrantStatus.Denied)]);

      await expect(
        service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' }),
      ).rejects.toThrow(PluginUpdateBlockedByDenialError);
      expect(db.pluginGrant.create).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();

      // The re-read must be the LOCKING form — a plain snapshot cannot
      // order itself against decide()'s update, which is the whole point.
      expect(grantLockCalls()).toHaveLength(1);
      const [template, pluginId] = grantLockCalls()[0] as [TemplateStringsArray, string];
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
      const grantModel = readPrismaModels(__dirname, 'plugin/plugin-grant.prisma');
      const scopeEnum = readPrismaModels(__dirname, 'enums/plugin-grant-scope.prisma');

      const table = prismaTable(grantModel, 'model', 'PluginGrant');
      const column = (field: string): string => prismaColumn(grantModel, 'PluginGrant', field);

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
      queueGrantLock([lockedRow('feedback:read', PluginGrantStatus.Denied)]);

      await expect(
        service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' }),
      ).rejects.toThrow(PluginUpdateBlockedByDenialError);

      const [template] = grantLockCalls()[0] as [TemplateStringsArray];
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
      queueGrantLock([lockedRow('feedback:read', PluginGrantStatus.Granted)]);

      const result = await service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' });

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
      queueGrantLock([lockedRow('user:impersonate', PluginGrantStatus.Granted)]);

      const failure = await service
        .approve({
          slug: 'demo-sink',
          approverId: 'admin-1',
          stagingId: 'staging-a',
          confirmCriticalSlugs: ['user:impersonate'],
        })
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
      const GRANT_DECISION_UNIQUE_INDEX = 'plugin_grants_plugin_id_scope_type_scope_id_permission_slug_key';

      // The index name is what `@prisma/adapter-pg@7.10` reports; the column
      // list is what 7.8 reported. Both must retry: a spelling the matcher
      // misses turns this race into a 500.
      const grantCollision = () =>
        uniqueViolation({ index: GRANT_DECISION_UNIQUE_INDEX, constraintName: GRANT_DECISION_UNIQUE_INDEX });
      const grantCollisionByColumns = () =>
        uniqueViolation({
          fields: ['plugin_id', 'scope_type', 'scope_id', 'permission_slug'],
          constraintName: GRANT_DECISION_UNIQUE_INDEX,
        });

      it.each([
        ['the index name', grantCollision],
        ['the column list', grantCollisionByColumns],
      ])(
        'retries the whole transaction on a collision reported by %s, and the second snapshot drops the decided check from the seed set',
        async (_spelling, makeCollision) => {
          db.plugin.findUnique.mockResolvedValue(pendingPlugin(nextManifest()));
          const seeded = makeGrant({ id: 'grant-3', permissionSlug: 'plugin|demo-sink|manage:digest' });
          db.pluginGrant.create.mockRejectedValueOnce(makeCollision()).mockResolvedValue(seeded);
          db.pluginGrant.findMany
            .mockResolvedValueOnce([]) // compare()
            .mockResolvedValueOnce([]); // serverChecksToSeed()
          queueGrantLock([]); // first attempt's locked read: nothing decided, so it seeds both and loses the race
          // The retry's locked read SEES the decision the first attempt
          // collided with, so the check drops out rather than colliding again.
          queueGrantLock([lockedRow('feedback:read', PluginGrantStatus.Granted)]);

          const result = await service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' });

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
        },
      );

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
        queueGrantLock([]); // first attempt's locked read: seeds, and collides with the denial being written
        queueGrantLock([lockedRow('feedback:read', PluginGrantStatus.Denied)]);

        // The durable-denial rule, not a 500: what the collision was hiding
        // is a refusal the retry can finally see.
        await expect(
          service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' }),
        ).rejects.toThrow(PluginUpdateBlockedByDenialError);
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
        queueGrantLock([]); // first attempt's locked read
        queueGrantLock([]); // retry: still undecided in ITS read, so it seeds and loses again

        await expect(
          service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' }),
        ).rejects.toBe(collision);
        expect(db.pluginGrant.create).toHaveBeenCalledTimes(2);
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      it.each([
        [
          'a unique violation on some other constraint',
          () => uniqueViolation({ fields: ['plugin_id', 'slug'], constraintName: 'plugin_permissions_slug_key' }),
        ],
        [
          'a unique violation on some other index',
          () =>
            uniqueViolation({ index: 'plugin_permissions_slug_key', constraintName: 'plugin_permissions_slug_key' }),
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
        queueGrantLock([]); // the only attempt's locked read

        await expect(
          service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' }),
        ).rejects.toBe(failure);
        expect(db.pluginGrant.create).toHaveBeenCalledTimes(1);
        expect(db.plugin.updateMany).toHaveBeenCalledTimes(1);
      });
    });

    /**
     * A deadlock is not a collision: nothing about this transaction was wrong,
     * Postgres simply chose it as the victim of a cycle. The abort took it
     * whole, so the recovery is the same one whole retry — and the same bound
     * (#398, D-398-2).
     */
    describe('a deadlock that aborts the activation transaction', () => {
      it('retries the whole transaction when Postgres picks this one as the victim', async () => {
        db.plugin.findUnique.mockResolvedValue(pendingPlugin(nextManifest()));
        const seeded = makeGrant({ id: 'grant-4', permissionSlug: 'plugin|demo-sink|manage:digest' });
        db.pluginGrant.create.mockRejectedValueOnce(deadlock()).mockResolvedValue(seeded);
        db.pluginGrant.findMany
          .mockResolvedValueOnce([]) // compare()
          .mockResolvedValueOnce([]); // serverChecksToSeed()
        queueGrantLock([]); // the victim attempt's locked read
        queueGrantLock([]); // the retry's own read

        const result = await service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' });

        // The retry seeds the FULL set, unlike the collision case above: a
        // deadlock says nothing about what any other transaction decided, so
        // the second attempt's locked read finds the same undecided checks.
        expect(result.seededGrants).toEqual([seeded, seeded]);
        expect(db.pluginGrant.create).toHaveBeenCalledTimes(3);
        // Re-claimed, not carried over: the aborted attempt released it.
        expect(db.plugin.updateMany).toHaveBeenCalledTimes(2);
        expect(emitter.emit).toHaveBeenCalledTimes(1);
      });

      it('propagates a second deadlock rather than looping on the contention', async () => {
        db.plugin.findUnique.mockResolvedValue(pendingPlugin(nextManifest()));
        const second = deadlock();
        db.pluginGrant.create.mockRejectedValueOnce(deadlock()).mockRejectedValueOnce(second);
        db.pluginGrant.findMany
          .mockResolvedValueOnce([]) // compare()
          .mockResolvedValueOnce([]); // serverChecksToSeed()
        queueGrantLock([]);
        queueGrantLock([]);

        await expect(
          service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' }),
        ).rejects.toBe(second);
        expect(db.plugin.updateMany).toHaveBeenCalledTimes(2);
        expect(emitter.emit).not.toHaveBeenCalled();
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

      await expect(
        service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' }),
      ).rejects.toThrow(PluginUpdateBlockedByDenialError);
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

      await expect(
        service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' }),
      ).rejects.toThrow(PluginUpdateCriticalConfirmationError);
    });

    it('activates: seeds ONLY undecided server checks Granted, promotes pending, announces re-consent to unconsented units (#1149)', async () => {
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
          ...UNIT_BOUND_RULES.Household,
          riskLevel: RiskLevel.Low,
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
      queueGrantLock([
        lockedRow('feedback:read', PluginGrantStatus.Granted),
        lockedRow('plugin|demo-sink|manage:digest', PluginGrantStatus.Granted),
      ]); // tx-local locked server re-read: unchanged since the gates
      db.householdPlugin.findMany.mockResolvedValue([makeUnit()]);

      const result = await service.approve({
        slug: 'demo-sink',
        approverId: 'admin-1',
        stagingId: 'staging-a',
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
          decidedById: 'admin-1',
          decidedRiskLevel: RiskLevel.Critical,
        }),
      });
      // Enabled units only: a switched-off unit's standing is read when it
      // switches on, not announced now.
      expect(db.householdPlugin.findMany).toHaveBeenCalledWith({ where: { pluginId: 'plugin-1', enabled: true } });
      // Activation writes nothing to unit enablements (#1149): the unit keeps running
      // on the grants it gave, and its consent standing reports the review.
      expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
      expect(db.userPlugin.updateMany).not.toHaveBeenCalled();
      // One grouped grant read — the query count must not follow the number
      // of households (the transaction would time out and roll the whole
      // update back).
      expect(db.pluginGrant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            scopeType: PluginGrantScope.Household,
            scopeId: { in: ['household-1'] },
            status: PluginGrantStatus.Granted,
          }),
        }),
      );
      const announced = householdReconsentEvents();
      expect(announced).toHaveLength(1);
      expect(announced[0]).toMatchObject({
        outstandingPermissionSlugs: ['calendar:read'],
        manifestVersion: '1.3.0',
        subjectId: 'hp-1',
        before: { id: 'hp-1', householdId: 'household-1', pluginId: 'plugin-1', enabled: true },
      });
      // The snapshot is the switch alone: nothing on the row moved.
      expect(announced[0].before).toEqual(announced[0].after);
      expect(announced[0].after).not.toHaveProperty('suspendedForConsent');
      expect(userReconsentEvents()).toEqual([]);
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginUpdateApprovedEvent.eventName,
        expect.objectContaining({
          grantedPermissions: [expect.objectContaining({ slug: 'user:impersonate', consentScope: 'server' })],
        }),
      );
      // The per-unit consequences ride the result (#321): the server admin who
      // approved sees them synchronously, not only on the event stream.
      expect(result.reconsentHouseholdUnits).toEqual([{ householdId: 'household-1', outstanding: ['calendar:read'] }]);
      expect(result.reconsentUserUnits).toEqual([]);
    });

    /**
     * Whether a household's unit can run under the manifest this activation
     * promotes is worked out when read, from the active manifest's scope and
     * the unit's retained `config` (#1151). Activation therefore has nothing to
     * write to any household unit enablement, whichever way the scope or the
     * schema moved, and its one read of them is the re-consent read (#392).
     */
    it.each([
      ['a household → server re-scope', nextManifest({ scope: 'server' })],
      ['a household-scope manifest', nextManifest({ scope: 'household' })],
      [
        'a household-scope manifest whose schema rejects a retained document',
        nextManifest({
          scope: 'household',
          config: {
            schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
            requiresHouseholdConfig: true,
          },
        }),
      ],
    ])(
      "activation writes no household unit enablement, whatever the new manifest's scope or schema: %s (#1151, #392)",
      async (_, next) => {
        db.plugin.findUnique.mockResolvedValue(pendingPlugin(next, { scope: PluginScope.Household }));
        db.plugin.findUniqueOrThrow.mockResolvedValue(pendingPlugin(next, { scope: PluginScope.Household }));
        db.householdPlugin.findMany.mockResolvedValue([
          makeUnit({ config: { webhookUrl: 42 } }),
          makeUnit({ id: 'hp-2', householdId: 'household-2', config: { webhookUrl: 'https://example.test/hook' } }),
        ]);

        await service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' });

        expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
        expect(db.householdPlugin.update).not.toHaveBeenCalled();
        expect(db.householdPlugin.findMany.mock.calls.length).toBeLessThanOrEqual(1);
      },
    );

    /**
     * Activation applies the retained-config rule a reinstall-over-tombstone
     * applies via `retainedServerConfig` (#370), so neither manifest-replacing
     * path leaves `Plugin.config` unchecked. The household axis needs no such
     * rule: a household unit's retained document is judged against the active
     * schema when read (#1151).
     */
    describe('server config retained-value rule (D-CN)', () => {
      const activateWith = async (manifest: PluginManifest, existingConfig: Prisma.JsonValue): Promise<void> => {
        db.plugin.findUnique.mockResolvedValue(pendingPlugin(manifest));
        // The locked, in-transaction read the claim's write depends on — NOT
        // the pre-transaction `plugin.findUnique` load, which a concurrent
        // config PATCH could have already moved past.
        setPluginConfigLock(existingConfig);

        await service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' });
      };

      it('carries retained server config forward when it still satisfies the new schema', async () => {
        await activateWith(nextManifest(), { webhookUrl: 'https://retained.example.test' });

        expect(db.plugin.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ config: { webhookUrl: 'https://retained.example.test' } }),
          }),
        );
        expect(emitter.emit).toHaveBeenCalledWith(
          PluginUpdateApprovedEvent.eventName,
          expect.objectContaining({ retainedConfigReset: false }),
        );
      });

      it('resets schema-invalid retained config to {} and records the reset on the event', async () => {
        await activateWith(
          nextManifest({
            config: {
              schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
              requiresHouseholdConfig: false,
            },
          }),
          { webhookUrl: 42 },
        );

        expect(db.plugin.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ config: {} }) }),
        );
        expect(emitter.emit).toHaveBeenCalledWith(
          PluginUpdateApprovedEvent.eventName,
          expect.objectContaining({ retainedConfigReset: true }),
        );
      });

      it('resets a non-object retained value the same way a fresh tombstone-less config would', async () => {
        await activateWith(nextManifest(), 'not-an-object' as unknown as Prisma.JsonValue);

        expect(db.plugin.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ config: {} }) }),
        );
      });

      it('reads the config fresh inside the transaction rather than the caller-loaded plugin, so a concurrent server config PATCH is not clobbered', async () => {
        // The pre-transaction load sees a stale value; only the tx-local
        // locked read below is what the write must be computed from.
        db.plugin.findUnique.mockResolvedValue(pendingPlugin(nextManifest(), { config: { webhookUrl: 'stale' } }));
        setPluginConfigLock({ webhookUrl: 'https://fresh.example.test' });

        await service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' });

        expect(db.plugin.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ config: { webhookUrl: 'https://fresh.example.test' } }),
          }),
        );
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
            ...UNIT_BOUND_RULES.Household,
            riskLevel: RiskLevel.Critical,
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
        const failure = await service
          .approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' })
          .catch((e: unknown) => e);

        expect(failure).toBeInstanceOf(PluginUpdateCriticalConfirmationError);
        expect(failure).toMatchObject({ expectedSlugs: ['feedback:read'] });
        expect(db.pluginGrant.create).not.toHaveBeenCalled();
      });

      it('re-stamps the existing grant at the new risk and approver', async () => {
        await service.approve({
          slug: 'demo-sink',
          approverId: 'admin-2',
          stagingId: 'staging-a',
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

      const result = await service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' });

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
      // Still requested, at another consent scope: a scope move, not a
      // permission the update stopped requesting (#577).
      expect(emitter.emit).not.toHaveBeenCalledWith(
        PluginGrantRevokedEvent.eventName,
        expect.objectContaining({ reason: 'permission-no-longer-requested' }),
      );
    });

    it('announces re-consent to a unit holding a STALE Granted row — presence of a grant is not consent at the new risk', async () => {
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
          ...UNIT_BOUND_RULES.Household,
          riskLevel: RiskLevel.Critical,
        } as unknown as Permission,
      ]);
      // compare() → serverChecksToSeed() → activate() grouped household read
      db.pluginGrant.findMany
        .mockResolvedValueOnce([staleGrant])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([staleGrant]);
      db.householdPlugin.findMany.mockResolvedValue([makeUnit()]);

      const result = await service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' });

      expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
      expect(householdReconsentEvents()).toEqual([
        expect.objectContaining({ subjectId: 'hp-1', outstandingPermissionSlugs: ['feedback:read'] }),
      ]);
      expect(result.reconsentHouseholdUnits).toEqual([{ householdId: 'household-1', outstanding: ['feedback:read'] }]);
    });

    it('reports and announces every uncovered unit, the result and the events naming the same units and slugs', async () => {
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
      queueGrantLock([lockedRow('plugin|demo-sink|manage:digest', PluginGrantStatus.Granted)]);
      db.householdPlugin.findMany.mockResolvedValue([makeUnit(), makeUnit({ id: 'hp-2', householdId: 'household-2' })]);

      const result = await service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' });

      // One announcement per unit, and the result names exactly the units and
      // slugs the events do (#321, #1149).
      const announced = householdReconsentEvents();
      expect(announced.map((event) => [event.before.householdId, event.outstandingPermissionSlugs])).toEqual([
        ['household-1', ['feedback:read']],
        ['household-2', ['feedback:read']],
      ]);
      expect(result.reconsentHouseholdUnits).toEqual(
        announced.map((event) => ({
          householdId: event.before.householdId,
          outstanding: event.outstandingPermissionSlugs,
        })),
      );
      expect(result.reconsentUserUnits).toEqual([]);
      expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
    });

    it('does NOT announce re-consent when the recorded risk still covers the current classification', async () => {
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
          ...UNIT_BOUND_RULES.Household,
          riskLevel: RiskLevel.Medium,
        } as unknown as Permission,
      ]);
      db.pluginGrant.findMany
        .mockResolvedValueOnce([coveringGrant])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([coveringGrant]);
      db.householdPlugin.findMany.mockResolvedValue([makeUnit()]);

      const result = await service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' });

      expect(householdReconsentEvents()).toEqual([]);
      expect(result.reconsentHouseholdUnits).toEqual([]);
      expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
    });

    it('a unit that already covers the new slug at covering risk is neither reported nor announced', async () => {
      // A household that granted the new permission on the staged manifest
      // ahead of time (pre-consent) owes nothing once it lands; one that did
      // not still does. Both run the plugin.
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
          ...UNIT_BOUND_RULES.Household,
          riskLevel: RiskLevel.Medium,
        } as unknown as Permission,
      ]);
      const preConsent = makeGrant({
        id: 'grant-pre',
        scopeType: PluginGrantScope.Household,
        scopeId: 'household-1',
        permissionSlug: 'calendar:read',
        decidedRiskLevel: RiskLevel.Medium,
      });
      // compare() → serverChecksToSeed() → activate() grouped household read
      db.pluginGrant.findMany
        .mockResolvedValueOnce([makeGrant(), preConsent])
        .mockResolvedValueOnce([makeGrant()])
        .mockResolvedValueOnce([preConsent]);
      db.householdPlugin.findMany.mockResolvedValue([makeUnit(), makeUnit({ id: 'hp-2', householdId: 'household-2' })]);

      const result = await service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' });

      expect(result.reconsentHouseholdUnits).toEqual([{ householdId: 'household-2', outstanding: ['calendar:read'] }]);
      expect(householdReconsentEvents()).toEqual([
        expect.objectContaining({ subjectId: 'hp-2', outstandingPermissionSlugs: ['calendar:read'] }),
      ]);
      expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
    });

    it('a disabled unit is not announced; its standing is read when it switches on', async () => {
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
          ...UNIT_BOUND_RULES.Household,
          riskLevel: RiskLevel.Low,
        } as unknown as Permission,
      ]);
      // Call order: compare() → serverChecksToSeed(); no enabled unit, so the
      // household grant read never runs.
      db.pluginGrant.findMany
        .mockResolvedValueOnce([makeGrant()]) // compare()
        .mockResolvedValueOnce([makeGrant()]); // serverChecksToSeed()
      // The household switched the plugin off and consented to nothing. The
      // mock honours the `enabled` filter the way the database would, so the
      // assertion is on behaviour, not on the query's spelling alone.
      const switchedOff = makeUnit({ enabled: false });
      db.householdPlugin.findMany.mockImplementation(((args: { where?: { enabled?: boolean } }) =>
        Promise.resolve(
          [switchedOff].filter((unit) => args.where?.enabled === undefined || unit.enabled === args.where.enabled),
        )) as never);

      const result = await service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' });

      expect(db.householdPlugin.findMany).toHaveBeenCalledWith({ where: { pluginId: 'plugin-1', enabled: true } });
      expect(result.reconsentHouseholdUnits).toEqual([]);
      expect(householdReconsentEvents()).toEqual([]);
      expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
    });
  });

  /**
   * The household pass's exact user-scope mirror (#225): same batched
   * candidate shape against `UserPlugin`, driven by `userReconsentSlugs`.
   * Household coverage above owns the full matrix; these assert the mirrored
   * wiring plus the two behaviors unique to the scope — user escalations never
   * server-gate, and rowless users are untouched by construction.
   */
  describe('user-scope re-consent (#225, #1149)', () => {
    const makeUserUnit = (overrides: Partial<UserPlugin> = {}): UserPlugin => ({
      id: 'up-1',
      userId: 'user-1',
      pluginId: 'plugin-1',
      enabled: true,
      config: {},
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
          ...UNIT_BOUND_RULES.User,
          riskLevel: RiskLevel.Low,
        } as unknown as Permission,
      ]);
    });

    it('a new required user check does NOT server-gate: the update activates in place and announces re-consent to uncovered user units', async () => {
      db.userPlugin.findMany.mockResolvedValue([makeUserUnit()]);
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
        where: { pluginId: 'plugin-1', enabled: true },
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
      expect(db.userPlugin.updateMany).not.toHaveBeenCalled();
      expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
      const announced = userReconsentEvents();
      expect(announced).toHaveLength(1);
      expect(announced[0]).toMatchObject({
        outstandingPermissionSlugs: ['read:user_digest'],
        manifestVersion: '1.3.0',
        subjectId: 'up-1',
        after: { id: 'up-1', userId: 'user-1', pluginId: 'plugin-1', enabled: true },
      });
      expect(announced[0].after).not.toHaveProperty('suspendedForConsent');
      expect(householdReconsentEvents()).toEqual([]);
    });

    it('approve reports the user units that owe re-consent, matching the events (#321, #1149)', async () => {
      const next = nextWithUserCheck();
      db.plugin.findUnique.mockResolvedValue(
        makePlugin({
          pendingVersion: next.version,
          pendingManifestJson: next as unknown as Prisma.JsonValue,
          pendingSha256: 'f'.repeat(64),
          pendingSince: new Date('2026-07-29T00:00:00Z'),
          pendingStagingId: 'staging-a',
        }),
      );
      db.userPlugin.findMany.mockResolvedValue([makeUserUnit(), makeUserUnit({ id: 'up-2', userId: 'user-2' })]);
      // compare() → serverChecksToSeed() → activate() user grants: user-2
      // already granted the new check (pre-consent), user-1 did not.
      db.pluginGrant.findMany
        .mockResolvedValueOnce([makeGrant()])
        .mockResolvedValueOnce([makeGrant()])
        .mockResolvedValueOnce([
          makeGrant({
            id: 'grant-u2',
            scopeType: PluginGrantScope.User,
            scopeId: 'user-2',
            permissionSlug: 'read:user_digest',
            decidedRiskLevel: RiskLevel.Low,
          }),
        ]);

      const result = await service.approve({ slug: 'demo-sink', approverId: 'admin-1', stagingId: 'staging-a' });

      expect(result.reconsentUserUnits).toEqual([{ userId: 'user-1', outstanding: ['read:user_digest'] }]);
      expect(result.reconsentHouseholdUnits).toEqual([]);
      expect(
        userReconsentEvents().map((event) => ({
          userId: event.before.userId,
          outstanding: event.outstandingPermissionSlugs,
        })),
      ).toEqual(result.reconsentUserUnits);
      expect(db.userPlugin.updateMany).not.toHaveBeenCalled();
    });

    it('does not announce re-consent to a unit whose Granted row still covers the current risk — and rowless users never enter the pass', async () => {
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
      queueGrantLock([
        lockedRow('feedback:read', PluginGrantStatus.Granted),
        lockedRow('plugin|demo-sink|manage:digest', PluginGrantStatus.Granted),
      ]);
      await writeManifest(nextWithUserCheck());

      await service.stage(input());

      // The unit query is the whole universe: users with no UserPlugin row
      // never appear, so nothing rowless can be announced by construction.
      expect(db.userPlugin.updateMany).not.toHaveBeenCalled();
      expect(userReconsentEvents()).toEqual([]);
    });

    it('announces re-consent to a unit holding a STALE Granted row — presence is not consent at the new risk', async () => {
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
          ...UNIT_BOUND_RULES.User,
          riskLevel: RiskLevel.High,
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
      await writeManifest(shared);

      const result = await service.stage(input());

      expect(result.comparison.userReconsentSlugs).toEqual(['read:user_digest']);
      expect(db.userPlugin.updateMany).not.toHaveBeenCalled();
      expect(userReconsentEvents()).toEqual([
        expect.objectContaining({ subjectId: 'up-1', outstandingPermissionSlugs: ['read:user_digest'] }),
      ]);
    });
  });

  describe('reject()', () => {
    const staged = (overrides: Partial<Plugin> = {}): Plugin =>
      makePlugin({
        pendingVersion: '1.3.0',
        pendingSha256: 'f'.repeat(64),
        pendingSince: new Date('2026-08-10T09:00:00Z'),
        pendingStagingId: 'staging-a',
        ...overrides,
      });
    const revokedEvents = (): PluginGrantRevokedEvent[] =>
      (emitter.emit.mock.calls as [string, unknown][])
        .map(([, event]) => event)
        .filter((event): event is PluginGrantRevokedEvent => event instanceof PluginGrantRevokedEvent);

    beforeEach(() => {
      // No household or user has pre-consented, unless a case says so.
      db.pluginGrant.findMany.mockResolvedValue([]);
    });

    it('reject deletes the pre-consents given to the staged update and announces each one (#1150)', async () => {
      // The active manifest asks households for calendar:read only. The
      // staged update added events:read for households and notes:read for
      // users, and one household and one user accepted them ahead of time.
      const active = buildPluginManifest({
        scope: 'household',
        permissions: {
          ...activeManifest.permissions,
          checks: [
            ...activeManifest.permissions.checks,
            {
              slug: 'calendar:read',
              required: false,
              reason: { en: 'Schedules digests around events.' },
              consentScope: 'household' as const,
            },
          ],
        },
      });
      db.plugin.findUnique.mockResolvedValue(staged({ manifestJson: active as unknown as Prisma.JsonValue }));
      const householdPreConsent = makeGrant({
        id: 'grant-hh',
        scopeType: PluginGrantScope.Household,
        scopeId: 'household-1',
        permissionSlug: 'events:read',
        actId: 'act-hh',
      });
      const userPreConsent = makeGrant({
        id: 'grant-user',
        scopeType: PluginGrantScope.User,
        scopeId: 'user-1',
        permissionSlug: 'notes:read',
        actId: 'act-user',
      });
      db.pluginGrant.findMany.mockResolvedValue([householdPreConsent, userPreConsent]);

      await service.reject({ slug: 'demo-sink', rejectorId: 'admin-1', stagingId: 'staging-a' });

      // Only household and user decisions the active manifest does not
      // request at their scope: a server decision is never a pre-consent, and
      // the household's decision on calendar:read is in force.
      expect(db.pluginGrant.findMany).toHaveBeenCalledWith({
        where: {
          pluginId: 'plugin-1',
          OR: [
            { scopeType: PluginGrantScope.Household, permissionSlug: { notIn: ['calendar:read'] } },
            { scopeType: PluginGrantScope.User, permissionSlug: { notIn: [] } },
          ],
        },
      });
      expect(db.pluginGrant.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['grant-hh', 'grant-user'] } } });
      // The clear claims the plugin row before the decisions are read, so a
      // staged review in flight is either read here or refused afterwards.
      expect(db.plugin.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        db.pluginGrant.findMany.mock.invocationCallOrder[0] ?? 0,
      );
      expect(revokedEvents()).toEqual([
        expect.objectContaining({
          subjectId: 'grant-hh',
          reason: 'staged-update-rejected',
          // The staged version the pre-consent was given to, not the active one.
          context: { manifestVersion: '1.3.0', actId: 'act-hh' },
        }),
        expect.objectContaining({
          subjectId: 'grant-user',
          reason: 'staged-update-rejected',
          context: { manifestVersion: '1.3.0', actId: 'act-user' },
        }),
      ]);
    });

    it('reject deletes nothing and announces no revocation when nobody pre-consented (#1150)', async () => {
      db.plugin.findUnique.mockResolvedValue(staged());

      await service.reject({ slug: 'demo-sink', rejectorId: 'admin-1', stagingId: 'staging-a' });

      expect(db.pluginGrant.deleteMany).not.toHaveBeenCalled();
      expect(revokedEvents()).toEqual([]);
    });

    it('reject still clears a staged update whose active manifest cannot be read, and leaves every decision alone (#1150)', async () => {
      // Which decisions are pre-consents is read from the active manifest.
      // One that no longer validates must not block the rejection, and must
      // not be guessed around.
      db.plugin.findUnique.mockResolvedValue(staged({ manifestJson: { slug: 'demo-sink' } as Prisma.JsonValue }));

      await service.reject({ slug: 'demo-sink', rejectorId: 'admin-1', stagingId: 'staging-a' });

      expect(db.plugin.updateMany).toHaveBeenCalledTimes(1);
      expect(db.pluginGrant.findMany).not.toHaveBeenCalled();
      expect(db.pluginGrant.deleteMany).not.toHaveBeenCalled();
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginUpdateRejectedEvent.eventName,
        expect.any(PluginUpdateRejectedEvent),
      );
      expect(revokedEvents()).toEqual([]);
    });

    it('reject clears only the staging it loaded, by its staging id (#357)', async () => {
      // The staging id joins the version in the predicate: a rejected
      // version can be re-staged under the same number from the same bytes,
      // and this clear must never take a replacement staging with it.
      db.plugin.findUnique.mockResolvedValue(
        makePlugin({
          pendingVersion: '1.3.0',
          pendingSha256: 'f'.repeat(64),
          pendingSince: new Date('2026-08-10T09:00:00Z'),
          pendingStagingId: 'staging-a',
        }),
      );

      await service.reject({ slug: 'demo-sink', rejectorId: 'admin-1', stagingId: 'staging-a' });

      expect(db.plugin.updateMany).toHaveBeenCalledWith({
        where: { id: 'plugin-1', pendingVersion: '1.3.0', pendingStagingId: 'staging-a', uninstalledAt: null },
        data: {
          pendingVersion: null,
          pendingManifestJson: Prisma.DbNull,
          pendingSha256: null,
          pendingSince: null,
          pendingStagingId: null,
        },
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginUpdateRejectedEvent.eventName,
        expect.any(PluginUpdateRejectedEvent),
      );
    });

    it('refuses without a pending update', async () => {
      await expect(
        service.reject({ slug: 'demo-sink', rejectorId: 'admin-1', stagingId: 'staging-a' }),
      ).rejects.toThrow(PluginUpdateNoPendingError);
    });

    it('reject refuses a staging id that is not the current staging, and writes nothing (#357)', async () => {
      db.plugin.findUnique.mockResolvedValue(
        makePlugin({ pendingVersion: '1.3.0', pendingSha256: 'f'.repeat(64), pendingStagingId: 'staging-b' }),
      );

      const failure = await service
        .reject({ slug: 'demo-sink', rejectorId: 'admin-1', stagingId: 'staging-a' })
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginUpdateStagingReplacedError);
      expect(failure).toMatchObject({ slug: 'demo-sink', stagingId: 'staging-a' });
      expect(db.plugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('reject answers a replaced staging when another one takes the slot between its check and its clear (#357)', async () => {
      db.plugin.findUnique
        .mockResolvedValueOnce(
          makePlugin({ pendingVersion: '1.3.0', pendingSha256: 'f'.repeat(64), pendingStagingId: 'staging-a' }),
        ) // the load
        .mockResolvedValue(
          makePlugin({ pendingVersion: '1.3.0', pendingSha256: 'f'.repeat(64), pendingStagingId: 'staging-b' }),
        ); // the guard's re-read
      db.plugin.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.reject({ slug: 'demo-sink', rejectorId: 'admin-1', stagingId: 'staging-a' }),
      ).rejects.toThrow(PluginUpdateStagingReplacedError);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('refuses — with no event — when the staged update it targeted resolved or was replaced mid-flight', async () => {
      // A reject racing an approve must not report "rejected" for an update
      // that in fact activated, and racing a replacement stage it must not
      // clear a version nobody decided on. The guarded write turns both
      // races into the typed no-pending refusal.
      db.plugin.findUnique
        .mockResolvedValueOnce(
          makePlugin({ pendingVersion: '1.3.0', pendingSha256: 'f'.repeat(64), pendingStagingId: 'staging-a' }),
        ) // the load
        .mockResolvedValue(makePlugin()); // the guard's re-read: still installed, pending gone
      db.plugin.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.reject({ slug: 'demo-sink', rejectorId: 'admin-1', stagingId: 'staging-a' }),
      ).rejects.toThrow(PluginUpdateNoPendingError);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('answers the tombstone, not no-pending, when an uninstall won the race', async () => {
      const uninstalledAt = new Date('2026-08-16T12:00:00Z');
      db.plugin.findUnique
        .mockResolvedValueOnce(
          makePlugin({ pendingVersion: '1.3.0', pendingSha256: 'f'.repeat(64), pendingStagingId: 'staging-a' }),
        )
        .mockResolvedValue(makePlugin({ uninstalledAt }));
      db.plugin.updateMany.mockResolvedValue({ count: 0 });

      const failure = await service
        .reject({ slug: 'demo-sink', rejectorId: 'admin-1', stagingId: 'staging-a' })
        .catch((err: unknown) => err);

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
        pendingSha256: 'f'.repeat(64),
        pendingSince,
        pendingStagingId: 'staging-a',
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

    it('reads a staged update whose checksum is not a checksum, since only approval uses it (#1117)', async () => {
      // Refusing it here would hide a staging the server admin may want to reject.
      db.plugin.findUnique.mockResolvedValue(stagedPlugin(nextManifest(), { pendingSha256: 'not-a-checksum' }));

      const description = await service.describePending('demo-sink');

      expect(description.plugin.pendingStagingId).toBe('staging-a');
      expect(description.plugin.pendingVersion).toBe('1.3.0');
      expect(description.comparison.escalations).toEqual([]);
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
      expect(description.noLongerRequested).toEqual([]);
    });

    it('reports the requested permissions approving stops requesting, whose decisions it deletes (#577)', async () => {
      // The same drop the activation test applies: feedback:read leaves the
      // checks while declares[] stays put. Approving deletes every decision
      // on it, so the screen has to say so before the admin approves.
      db.plugin.findUnique.mockResolvedValue(
        stagedPlugin(
          nextManifest({
            permissions: {
              ...activeManifest.permissions,
              checks: activeManifest.permissions.checks.filter((check) => check.slug !== 'feedback:read'),
            },
          }),
        ),
      );

      const description = await service.describePending('demo-sink');

      expect(description.noLongerRequested).toEqual(['feedback:read']);
      expect(description.declares).toEqual({ added: [], removed: [] });
    });

    it('leaves a dropped declaration to the declares diff, never listing it twice (#577)', async () => {
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

      expect(description.declares.removed).toEqual(['plugin|demo-sink|manage:digest']);
      expect(description.noLongerRequested).toEqual([]);
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
