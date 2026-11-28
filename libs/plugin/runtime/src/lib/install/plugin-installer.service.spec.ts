import type { AuditContextService } from '@bge/actor-context';
import type {
  DatabaseService,
  HouseholdPlugin,
  Permission,
  Plugin,
  PluginGrant,
  PluginPermission,
} from '@bge/database';
import {
  PluginCategory,
  PluginConsentActKind,
  PluginExecutionMode,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  RiskLevel,
  SERVER_SCOPE_SENTINEL,
} from '@bge/database';
import type { MockDatabaseService } from '@bge/testing';
import { createMockDatabaseService, UNIT_BOUND_RULES } from '@bge/testing';
import type { StaticAnalysisFinding, StaticAnalysisReport } from '@boardgamesempire/plugin-analysis';
import type { PluginArtifactDirectory, PluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { buildPluginArtifactSha256 as sha } from '@boardgamesempire/plugin-contract';
import type { PluginManifest } from '@boardgamesempire/plugin-manifest';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { Logger } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { PluginConsentActStaleError } from '../consent/plugin-consent-act.errors';
import { PluginInstalledEvent } from '../events/plugin.events';
import type { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import { PluginDirectoryLayoutError } from '../loader/loader.errors';
import type { PluginDirectoryResolverService } from '../loader/plugin-directory-resolver.service';
import { buildPluginModuleOptions } from '../testing/plugin-module-options.fixture';
import {
  PluginInstallAuthorityError,
  PluginInstallConflictError,
  PluginInstallCriticalConfirmationError,
  PluginInstallDataGatewayNameConflictError,
  PluginInstallForbiddenPermissionError,
  PluginInstallManifestError,
  PluginInstallPermissionCollisionError,
  PluginInstallStaticAnalysisError,
  PluginInstallUnknownCorePermissionError,
  PluginReinstallConflictError,
} from './install.errors';
import { DEFAULT_PLUGIN_EXECUTION_MODE } from './manifest-enum.maps';
import type { PluginInstallInput } from './plugin-installer.service';
import { PluginInstallerService } from './plugin-installer.service';
import type { PluginStaticAnalysisService } from './plugin-static-analysis.service';

describe('PluginInstallerService', () => {
  const options = buildPluginModuleOptions();

  const emptyReport: StaticAnalysisReport = {
    findings: [],
    scannedFileCount: 3,
    deepScannedFileCount: 0,
    truncated: false,
  };

  const makePlugin = (overrides: Partial<Plugin> = {}): Plugin => ({
    id: 'plugin-1',
    slug: 'demo-sink',
    version: '1.2.0',
    category: PluginCategory.FeedbackSink,
    scope: PluginScope.Server,
    executionMode: PluginExecutionMode.InProcess,
    enabled: false,
    manifestJson: {},
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
    installedSha256: 'a'.repeat(64),
    registrySlug: null,
    pendingVersion: null,
    pendingManifestJson: null,
    pendingSha256: null,
    pendingSince: null,
    pendingStagingId: null,
    pendingFromUrl: null,
    pendingRegistrySlug: null,
    restartRequired: false,
    uninstalledAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  const householdRow = (overrides: Partial<HouseholdPlugin> = {}): HouseholdPlugin => ({
    id: 'hp-1',
    householdId: 'hh-1',
    pluginId: 'plugin-1',
    enabled: true,
    config: { webhookUrl: 'https://example.test/hook' },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  const makePluginPermission = (overrides: Partial<PluginPermission> = {}): PluginPermission => ({
    id: 'perm-1',
    pluginId: 'plugin-1',
    slug: 'plugin|demo-sink|manage:digest',
    riskLevel: RiskLevel.Low,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  const makePluginGrant = (overrides: Partial<PluginGrant> = {}): PluginGrant => ({
    id: 'grant-1',
    pluginId: 'plugin-1',
    scopeType: PluginGrantScope.Server,
    scopeId: '',
    permissionSlug: 'plugin|demo-sink|manage:digest',
    status: PluginGrantStatus.Granted,
    decidedById: null,
    actId: 'act-1',
    decidedRiskLevel: RiskLevel.Low,
    decidedAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  let rootDir: string;
  let db: MockDatabaseService;
  let authority: jest.Mocked<Pick<PluginGrantAuthorityService, 'isServerAdmin'>>;
  let analyzer: jest.Mocked<Pick<PluginStaticAnalysisService, 'analyze'>>;
  let emitter: { emit: jest.Mock };
  let directories: { confirm: jest.Mock };
  let service: PluginInstallerService;

  const directory = (): PluginArtifactDirectory => ({
    slug: 'demo-sink',
    sha256: sha('a'),
    rootDir,
    manifestPath: join(rootDir, 'manifest.json'),
    packageJsonPath: join(rootDir, 'package.json'),
  });

  const writeManifest = async (manifest: PluginManifest): Promise<void> => {
    await writeFile(join(rootDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  };

  /**
   * The fixture's checks: `manage:digest` (plugin-declared, server consent,
   * required) and `feedback:read` (core, server consent, optional). The
   * core row is classified Medium here so risk propagation is observable.
   */
  const feedbackRead = { slug: 'feedback:read', subject: 'feedback', riskLevel: RiskLevel.Medium } as Permission;

  const input = (overrides: Partial<PluginInstallInput> = {}): PluginInstallInput => ({
    directory: directory(),
    url: 'https://registry.example/demo-sink-1.2.0.tgz',
    registrySlug: 'bge-official',
    installerId: 'admin-1',
    ...overrides,
  });

  const installedEvent = (): PluginInstalledEvent => {
    const call = emitter.emit.mock.calls[0] as [string, PluginInstalledEvent] | undefined;

    if (!call) {
      throw new Error('no plugin lifecycle event was emitted');
    }

    return call[1];
  };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    rootDir = await mkdtemp(join(tmpdir(), 'bge-installer-'));
    await writeManifest(buildPluginManifest());

    db = createMockDatabaseService();
    db.$transaction.mockImplementation((cb) => cb(db));
    db.plugin.findUnique.mockResolvedValue(null);
    db.plugin.create.mockResolvedValue(makePlugin());
    db.pluginPermission.findMany.mockResolvedValue([]);
    db.pluginPermission.create.mockResolvedValue(makePluginPermission());
    db.pluginGrant.upsert.mockResolvedValue(makePluginGrant());
    db.pluginConsentAct.create.mockImplementation((({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'act-1', createdAt: new Date(0), ...data })) as never);
    db.permission.findMany.mockResolvedValue([feedbackRead]);
    db.householdPlugin.findMany.mockResolvedValue([]);

    authority = { isServerAdmin: jest.fn() } satisfies Partial<jest.Mocked<PluginGrantAuthorityService>> as jest.Mocked<
      Pick<PluginGrantAuthorityService, 'isServerAdmin'>
    >;
    authority.isServerAdmin.mockResolvedValue(true);

    analyzer = { analyze: jest.fn() } satisfies Partial<jest.Mocked<PluginStaticAnalysisService>> as jest.Mocked<
      Pick<PluginStaticAnalysisService, 'analyze'>
    >;
    analyzer.analyze.mockResolvedValue(emptyReport);

    emitter = { emit: jest.fn() };
    // The resolver's own spec covers the layout; here it confirms whatever
    // directory the case hands over.
    directories = { confirm: jest.fn((dir: PluginArtifactDirectory) => Promise.resolve(dir)) };

    service = new PluginInstallerService(
      db as unknown as DatabaseService,
      authority as unknown as PluginGrantAuthorityService,
      analyzer as unknown as PluginStaticAnalysisService,
      new PluginConfigSchemaService(),
      emitter as unknown as EventEmitter2,
      options,
      directories as unknown as PluginDirectoryResolverService,
      { getCorrelationId: () => 'corr-1' } as unknown as AuditContextService,
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  describe('happy path', () => {
    it('persists the Plugin row with mapped enums, provenance columns, and the validated manifest', async () => {
      const result = await service.install(input());

      expect(db.plugin.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          slug: 'demo-sink',
          version: '1.2.0',
          category: 'FeedbackSink',
          scope: 'Server',
          executionMode: 'InProcess',
          installedFromUrl: 'https://registry.example/demo-sink-1.2.0.tgz',
          installedSha256: 'a'.repeat(64),
          registrySlug: 'bge-official',
          installedById: 'admin-1',
          manifestJson: expect.objectContaining({ slug: 'demo-sink', version: '1.2.0' }),
        }),
      });
      expect(result.plugin.id).toBe('plugin-1');
      expect(result.warnings).toEqual([]);
      expect(result.analysis).toBe(emptyReport);
    });

    it("records the artifact directory's checksum as installedSha256 (#224)", async () => {
      // The directory's name is the artifact's checksum, so the install takes
      // it from there rather than from a second input that could disagree. A
      // link or registry the install leaves out is stored as null (#696).
      await service.install(
        input({ directory: { ...directory(), sha256: sha('c') }, url: undefined, registrySlug: undefined }),
      );

      const [{ data }] = db.plugin.create.mock.calls[0] as [{ data: Record<string, unknown> }];
      expect(data).toEqual(
        expect.objectContaining({ installedSha256: 'c'.repeat(64), installedFromUrl: null, registrySlug: null }),
      );
      expect(installedEvent().provenance).toEqual({
        sha256: sha('c'),
        url: null,
        registrySlug: null,
      });
    });

    it('records where the artifact came from under the provenance names the client reads (#1117)', async () => {
      const artifact = directory();

      await service.install({ directory: artifact, url: 'https://example.test/a.tgz', installerId: 'admin-1' });

      expect(installedEvent().provenance).toEqual({
        sha256: artifact.sha256,
        url: 'https://example.test/a.tgz',
        registrySlug: null,
      });
      const [{ data }] = db.plugin.create.mock.calls[0] as [{ data: Record<string, unknown> }];
      expect(data).toEqual(
        expect.objectContaining({
          installedSha256: artifact.sha256,
          installedFromUrl: 'https://example.test/a.tgz',
          registrySlug: null,
        }),
      );
    });

    it('creates one PluginPermission row per declare, classified explicit Low', async () => {
      const result = await service.install(input());

      expect(db.pluginPermission.create).toHaveBeenCalledTimes(1);
      expect(db.pluginPermission.create).toHaveBeenCalledWith({
        data: { pluginId: 'plugin-1', slug: 'plugin|demo-sink|manage:digest', riskLevel: RiskLevel.Low },
      });
      expect(result.declaredPermissions).toHaveLength(1);
    });

    it('seeds Granted server-scope rows for EVERY server-consentable check — required and optional, both origins', async () => {
      const result = await service.install(input());

      expect(db.pluginGrant.upsert).toHaveBeenCalledTimes(2);
      expect(db.pluginGrant.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            pluginId: 'plugin-1',
            scopeType: PluginGrantScope.Server,
            scopeId: SERVER_SCOPE_SENTINEL,
            permissionSlug: 'plugin|demo-sink|manage:digest',
            status: PluginGrantStatus.Granted,
            decidedById: 'admin-1',
            decidedRiskLevel: RiskLevel.Low,
          }),
        }),
      );
      expect(db.pluginGrant.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            permissionSlug: 'feedback:read',
            // Core risk propagates from the Permission row into decidedRiskLevel — the baseline
            // update-time risk escalation compares against (#59).
            decidedRiskLevel: RiskLevel.Medium,
          }),
        }),
      );
      expect(result.seededGrants).toHaveLength(2);
    });

    it('emits plugin.installed post-commit with provenance, resolved-reason grant records, and analysis findings', async () => {
      const warningFinding: StaticAnalysisFinding = {
        file: 'io.js',
        kind: 'esm-import',
        specifier: 'node:fs',
        severity: 'warning',
        scanScope: 'default',
      };
      analyzer.analyze.mockResolvedValue({
        findings: [warningFinding],
        scannedFileCount: 1,
        deepScannedFileCount: 0,
        truncated: false,
      });

      await service.install(input());

      expect(emitter.emit).toHaveBeenCalledTimes(1);
      const [eventName] = emitter.emit.mock.calls[0] as [string, PluginInstalledEvent];
      const event = installedEvent();
      expect(eventName).toBe(PluginInstalledEvent.eventName);
      expect(event.after).toEqual({
        id: 'plugin-1',
        slug: 'demo-sink',
        version: '1.2.0',
        category: 'FeedbackSink',
        scope: 'Server',
        enabled: false,
      });
      expect(event.provenance).toEqual({
        sha256: sha('a'),
        url: 'https://registry.example/demo-sink-1.2.0.tgz',
        registrySlug: 'bge-official',
      });
      expect(event.grantedPermissions).toEqual([
        {
          slug: 'plugin|demo-sink|manage:digest',
          required: true,
          consentScope: 'server',
          reason: 'Stores and manages the digest configuration it owns.',
        },
        {
          slug: 'feedback:read',
          required: false,
          consentScope: 'server',
          reason: 'Reads submitted feedback to compose the weekly digest.',
        },
      ]);
      expect(event.auditFindings).toBeNull();
      expect(event.staticAnalysis).toEqual([warningFinding]);
      expect(event.acknowledgedForbiddenImports).toEqual([]);
    });

    it('passes the deep-scan opt-in through to the analyzer', async () => {
      await service.install(input({ deepScan: true }));

      expect(analyzer.analyze).toHaveBeenCalledWith(directory(), { deepScan: true });
    });

    it('omits executionMode when the manifest carries no hint, leaving the column default', async () => {
      const manifest = buildPluginManifest();
      delete manifest.executionMode;
      await writeManifest(manifest);

      await service.install(input());

      const [{ data }] = db.plugin.create.mock.calls[0] as [{ data: Record<string, unknown> }];
      expect('executionMode' in data).toBe(false);
    });
  });

  describe('the InstallAccept consent act (#1336)', () => {
    it('writes one InstallAccept act naming the artifact sha, and every seeded decision names it (#1336)', async () => {
      const result = await service.install(input());

      expect(db.pluginConsentAct.create).toHaveBeenCalledTimes(1);
      expect(db.pluginConsentAct.create).toHaveBeenCalledWith({
        data: {
          pluginId: 'plugin-1',
          pluginSlug: 'demo-sink',
          kind: PluginConsentActKind.InstallAccept,
          scopeType: PluginGrantScope.Server,
          scopeId: SERVER_SCOPE_SENTINEL,
          manifestVersion: '1.2.0',
          manifestSha256: sha('a'),
          // An install answers no staged update (#1152).
          stagingId: null,
          presentation: expect.any(Object),
          decidedById: 'admin-1',
          decidedAt: expect.any(Date),
          correlationId: 'corr-1',
        },
      });
      expect(result.act.id).toBe('act-1');
      expect(db.pluginGrant.upsert).toHaveBeenCalledTimes(2);

      for (const [{ create }] of db.pluginGrant.upsert.mock.calls as unknown as [{ create: { actId: string } }][]) {
        expect(create.actId).toBe(result.act.id);
      }
    });

    it('names the act on plugin.installed, so its lifecycle row can find what the server admin was shown (#1336)', async () => {
      const result = await service.install(input());

      expect(installedEvent().actId).toBe(result.act.id);
    });

    it('records the act and its decisions at the same instant, the install time (#1336)', async () => {
      await service.install(input());

      const [[{ data: act }]] = db.pluginConsentAct.create.mock.calls as unknown as [[{ data: { decidedAt: Date } }]];
      const [{ create: decision }] = db.pluginGrant.upsert.mock.calls[0] as unknown as [
        { create: { decidedAt: Date } },
      ];
      const [{ data: plugin }] = db.plugin.create.mock.calls[0] as unknown as [{ data: { installedAt: Date } }];
      expect(decision.decidedAt).toBe(act.decidedAt);
      expect(plugin.installedAt).toBe(act.decidedAt);
    });

    it('records what the server admin was shown: every server-scope requested permission, granted, in the default locale (#1336)', async () => {
      await service.install(input());

      const [[{ data }]] = db.pluginConsentAct.create.mock.calls as unknown as [[{ data: { presentation: unknown } }]];
      expect(data.presentation).toEqual({
        locale: options.defaultLocale,
        source: 'active',
        checks: [
          {
            slug: 'plugin|demo-sink|manage:digest',
            required: true,
            feature: null,
            riskLevel: RiskLevel.Low,
            reason: 'Stores and manages the digest configuration it owns.',
            usedFallback: false,
            outcome: 'granted',
          },
          {
            slug: 'feedback:read',
            required: false,
            feature: 'weekly-digest',
            riskLevel: RiskLevel.Medium,
            reason: 'Reads submitted feedback to compose the weekly digest.',
            usedFallback: false,
            outcome: 'granted',
          },
        ],
      });
    });

    it("records the presentation in the installing server admin's locale when one is given (#1336)", async () => {
      await service.install(input({ locale: 'fr' }));

      const [[{ data }]] = db.pluginConsentAct.create.mock.calls as unknown as [
        [{ data: { presentation: { checks: { usedFallback: boolean }[]; locale: string } } }],
      ];
      expect(data.presentation.locale).toBe('fr');
      // The fixture's reasons are English only, so each fell back.
      expect(data.presentation.checks.every((shown) => shown.usedFallback)).toBe(true);
    });

    it('seeds the decisions in code-unit order of slug, the lock order every writer of the Server unit takes (#1336)', async () => {
      await service.install(input());

      const slugs = (db.pluginGrant.upsert.mock.calls as unknown as [{ create: { permissionSlug: string } }][]).map(
        ([{ create }]) => create.permissionSlug,
      );
      expect(slugs).toEqual(['feedback:read', 'plugin|demo-sink|manage:digest']);
    });

    it('writes the act even when the manifest requests nothing of the server (#1336)', async () => {
      const manifest = buildPluginManifest();
      manifest.permissions = { declares: [], checks: [] };
      await writeManifest(manifest);

      const result = await service.install(input());

      expect(db.pluginConsentAct.create).toHaveBeenCalledTimes(1);
      expect(db.pluginConsentAct.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          kind: PluginConsentActKind.InstallAccept,
          presentation: { locale: options.defaultLocale, source: 'active', checks: [] },
        }),
      });
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
      expect(result.act.id).toBe('act-1');
    });

    it('writes no act when the install is refused inside the transaction (#1336)', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ id: 'existing' }));

      await expect(service.install(input())).rejects.toBeInstanceOf(PluginInstallConflictError);
      expect(db.pluginConsentAct.create).not.toHaveBeenCalled();
    });
  });

  describe('assess (#1094)', () => {
    const forbidden: StaticAnalysisFinding = {
      file: 'index.js',
      kind: 'esm-import',
      specifier: '@bge/database',
      severity: 'forbidden',
      scanScope: 'default',
    };

    it('assesses without confirmations and lists what install will ask for', async () => {
      const manifest = buildPluginManifest();
      manifest.permissions.checks = [
        ...manifest.permissions.checks,
        { slug: 'read:audit_log', required: true, reason: { en: 'Mirrors audit rows into the external sink.' } },
      ];
      await writeManifest(manifest);
      db.permission.findMany.mockResolvedValue([
        feedbackRead,
        { slug: 'read:audit_log', subject: 'audit_log', riskLevel: RiskLevel.Critical } as Permission,
      ]);
      const report: StaticAnalysisReport = { ...emptyReport, findings: [forbidden, { ...forbidden, file: 'b.js' }] };
      analyzer.analyze.mockResolvedValue(report);

      const assessment = await service.assess(directory(), { deepScan: true });

      expect(assessment.criticalSlugsToReenter).toEqual(['read:audit_log']);
      expect(assessment.forbiddenImportsToAccept).toEqual(['@bge/database']);
      expect(assessment.analysis).toBe(report);
      expect(assessment.validated.manifest.slug).toBe('demo-sink');
      expect(assessment.serverChecks).toHaveLength(3);
      expect(analyzer.analyze).toHaveBeenCalledWith(directory(), { deepScan: true });
      expect(authority.isServerAdmin).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.plugin.create).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it("scans only the plugin's own files unless asked to go deeper (#1094)", async () => {
      await writeManifest(buildPluginManifest());

      await service.assess(directory());

      expect(analyzer.analyze).toHaveBeenCalledWith(directory(), { deepScan: false });
    });

    it('checks authority before it touches the directory or reads the manifest (#1094)', async () => {
      authority.isServerAdmin.mockResolvedValue(false);
      const read = jest.spyOn(jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises'), 'readFile');

      await expect(service.install(input())).rejects.toBeInstanceOf(PluginInstallAuthorityError);

      expect(directories.confirm).not.toHaveBeenCalled();
      expect(analyzer.analyze).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(db.permission.findMany).not.toHaveBeenCalled();
    });
  });

  describe('manifest gate', () => {
    it('refuses a directory the loader could not resolve at the next boot, and records nothing (#224)', async () => {
      directories.confirm.mockRejectedValue(new PluginDirectoryLayoutError('demo-sink', 'checksum fails the pattern'));

      await expect(
        service.install(
          input({
            directory: {
              ...directory(),
              sha256: `sha256:${'A'.repeat(64)}` as unknown as PluginArtifactSha256,
            },
          }),
        ),
      ).rejects.toBeInstanceOf(PluginDirectoryLayoutError);
      expect(db.plugin.create).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('reads the manifest from the directory the resolver confirms (#224)', async () => {
      // The handed-over manifest path names nothing; the install succeeds
      // only by reading the manifest at the path the resolver gives.
      const handed = { ...directory(), manifestPath: join(rootDir, 'elsewhere.json') };
      directories.confirm.mockResolvedValue(directory());

      await expect(service.install(input({ directory: handed }))).resolves.toBeDefined();
      expect(directories.confirm).toHaveBeenCalledWith(handed);
    });

    it('rejects unreadable manifest JSON', async () => {
      await writeFile(join(rootDir, 'manifest.json'), '{ not json', 'utf-8');

      await expect(service.install(input())).rejects.toBeInstanceOf(PluginInstallManifestError);
    });

    it('rejects an invalid manifest, carrying the validation issues', async () => {
      await writeManifest(buildPluginManifest({ version: 'not-semver' }));

      const failure = await service.install(input()).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginInstallManifestError);
      expect((failure as PluginInstallManifestError).issues?.length).toBeGreaterThan(0);
    });

    it('enforces bgeCompat at install — unlike consent-time re-validation', async () => {
      await writeManifest(buildPluginManifest({ bgeCompat: '>=99.0.0' }));

      await expect(service.install(input())).rejects.toBeInstanceOf(PluginInstallManifestError);
    });

    it('rejects a manifest whose slug does not match the directory it arrived in', async () => {
      await writeManifest(buildPluginManifest({ slug: 'other-plugin' }));

      await expect(service.install(input())).rejects.toBeInstanceOf(PluginInstallManifestError);
    });
  });

  describe('categorical exclusions', () => {
    it('rejects a declared bare slug mimicking the plugin-administration vocabulary — even when never checked', async () => {
      const manifest = buildPluginManifest();
      manifest.permissions = {
        ...manifest.permissions,
        declares: [...manifest.permissions.declares, 'manage:plugin:household'],
      };
      await writeManifest(manifest);

      await expect(service.install(input())).rejects.toBeInstanceOf(PluginInstallForbiddenPermissionError);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it("rejects a declared bare slug claiming the 'all' subject", async () => {
      const manifest = buildPluginManifest();
      manifest.permissions = { ...manifest.permissions, declares: [...manifest.permissions.declares, 'read:all'] };
      await writeManifest(manifest);

      await expect(service.install(input())).rejects.toBeInstanceOf(PluginInstallForbiddenPermissionError);
    });

    it('rejects a core check on plugin-administration authority before the DB lookup', async () => {
      const manifest = buildPluginManifest();
      manifest.permissions.checks = [
        ...manifest.permissions.checks,
        { slug: 'manage:plugin', required: false, reason: { en: 'Wants to approve its own future grants.' } },
      ];
      await writeManifest(manifest);

      await expect(service.install(input())).rejects.toBeInstanceOf(PluginInstallForbiddenPermissionError);
      // Pattern-based on purpose: the refusal must not depend on the C4 seed
      // rows existing, so it cannot be a post-fetch check.
      expect(db.permission.findMany).not.toHaveBeenCalled();
    });

    it("rejects a core check whose Permission row carries the wildcard 'all' subject", async () => {
      const manifest = buildPluginManifest();
      manifest.permissions.checks = [
        ...manifest.permissions.checks,
        { slug: 'manage:everything', required: false, reason: { en: 'Asks for the universal subject.' } },
      ];
      await writeManifest(manifest);
      db.permission.findMany.mockResolvedValue([
        feedbackRead,
        { slug: 'manage:everything', subject: 'all', riskLevel: RiskLevel.Critical } as Permission,
      ]);

      await expect(service.install(input())).rejects.toBeInstanceOf(PluginInstallForbiddenPermissionError);
    });

    // A plugin's ability denies the attendance-only types after every allow,
    // so a consent to one could never confer anything (#1543).
    it('rejects a core check whose Permission row is on an attendance-only type (#1543)', async () => {
      const manifest = buildPluginManifest();
      manifest.permissions.checks = [
        ...manifest.permissions.checks,
        { slug: 'read:event_chat_message', required: false, reason: { en: 'Reads event chats.' } },
      ];
      await writeManifest(manifest);
      db.permission.findMany.mockResolvedValue([
        feedbackRead,
        { slug: 'read:event_chat_message', subject: 'EventChatMessage', riskLevel: RiskLevel.Medium } as Permission,
      ]);

      await expect(service.install(input())).rejects.toMatchObject({
        constructor: PluginInstallForbiddenPermissionError,
        permissionSlug: 'read:event_chat_message',
      });
    });
  });

  describe('authority and core-permission existence', () => {
    it('rejects a non-admin installer before touching permission data', async () => {
      authority.isServerAdmin.mockResolvedValue(false);

      await expect(service.install(input())).rejects.toBeInstanceOf(PluginInstallAuthorityError);
      expect(db.permission.findMany).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('collects EVERY missing core permission before failing (step 3, DB half)', async () => {
      const manifest = buildPluginManifest();
      manifest.permissions.checks = [
        ...manifest.permissions.checks,
        { slug: 'read:ghost_table', required: false, reason: { en: 'References a permission that does not exist.' } },
      ];
      await writeManifest(manifest);
      db.permission.findMany.mockResolvedValue([]);

      const failure = await service.install(input()).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginInstallUnknownCorePermissionError);
      const missing = (failure as PluginInstallUnknownCorePermissionError).missingSlugs;
      expect(missing).toHaveLength(2);
      expect(missing).toEqual(expect.arrayContaining(['feedback:read', 'read:ghost_table']));
    });
  });

  describe('Critical second factor', () => {
    const withCriticalCheck = async (required: boolean): Promise<void> => {
      const manifest = buildPluginManifest();
      manifest.permissions.checks = [
        ...manifest.permissions.checks,
        { slug: 'read:audit_log', required, reason: { en: 'Mirrors audit rows into the external sink.' } },
      ];
      await writeManifest(manifest);
      db.permission.findMany.mockResolvedValue([
        feedbackRead,
        { slug: 'read:audit_log', subject: 'audit_log', riskLevel: RiskLevel.Critical } as Permission,
      ]);
    };

    it('demands exact re-entry of every Critical slug, carrying the expected set on the error', async () => {
      await withCriticalCheck(true);

      const failure = await service.install(input()).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginInstallCriticalConfirmationError);
      expect((failure as PluginInstallCriticalConfirmationError).expectedSlugs).toEqual(['read:audit_log']);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('proceeds on exact confirmation', async () => {
      await withCriticalCheck(true);

      await expect(service.install(input({ confirmCriticalSlugs: ['read:audit_log'] }))).resolves.toBeDefined();
    });

    it('rejects EXTRA confirmed slugs — caller and server must agree on what is being consented to', async () => {
      await withCriticalCheck(true);

      await expect(
        service.install(input({ confirmCriticalSlugs: ['read:audit_log', 'feedback:read'] })),
      ).rejects.toBeInstanceOf(PluginInstallCriticalConfirmationError);
    });

    /**
     * `required: false` does NOT exempt a Critical permission. Every
     * server-consentable check is seeded `Granted`, so an optional Critical
     * check confers byte-identical authority — the confirmation set tracks
     * what is granted, not what the author marked required.
     */
    describe('an OPTIONAL Critical check is still granted, so it is still confirmed', () => {
      it('refuses an unconfirmed install rather than auto-granting Critical authority', async () => {
        await withCriticalCheck(false);

        const failure = await service.install(input()).catch((err: unknown) => err);

        expect(failure).toBeInstanceOf(PluginInstallCriticalConfirmationError);
        expect((failure as PluginInstallCriticalConfirmationError).expectedSlugs).toEqual(['read:audit_log']);
        expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
      });

      it('grants it on confirmation, with the Critical risk captured on the row', async () => {
        await withCriticalCheck(false);

        await service.install(input({ confirmCriticalSlugs: ['read:audit_log'] }));

        expect(db.pluginGrant.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            create: expect.objectContaining({
              permissionSlug: 'read:audit_log',
              status: PluginGrantStatus.Granted,
              decidedRiskLevel: RiskLevel.Critical,
            }),
          }),
        );
      });
    });

    it('demands nothing when no Critical permission is requested at all', async () => {
      await expect(service.install(input())).resolves.toBeDefined();
    });
  });

  /**
   * Install grants every server-scope requested permission at today's risk,
   * so the risks the artifact read showed are checked against today's (#1336).
   */
  describe('the risks the artifact read showed', () => {
    const withCriticalRisk = async (): Promise<void> => {
      const manifest = buildPluginManifest();
      manifest.permissions.checks = [
        ...manifest.permissions.checks,
        { slug: 'read:audit_log', required: true, reason: { en: 'Mirrors audit rows into the external sink.' } },
      ];
      await writeManifest(manifest);
      db.permission.findMany.mockResolvedValue([
        feedbackRead,
        { slug: 'read:audit_log', subject: 'audit_log', riskLevel: RiskLevel.Critical } as Permission,
      ]);
    };

    const CURRENT = [
      { permissionSlug: 'plugin|demo-sink|manage:digest', riskLevel: RiskLevel.Low },
      { permissionSlug: 'feedback:read', riskLevel: RiskLevel.Medium },
    ];

    it("installs when every risk shown is today's (#1336)", async () => {
      await expect(service.install(input({ shownRisks: CURRENT }))).resolves.toBeDefined();
    });

    it('refuses as stale a risk that changed after the read, ahead of the Critical confirmation, writing nothing (#1336)', async () => {
      // read:audit_log was shown High and is Critical now: the Critical set
      // the read named is stale too, so stale is what the admin hears.
      await withCriticalRisk();
      const shown = [...CURRENT, { permissionSlug: 'read:audit_log', riskLevel: RiskLevel.High }];

      const failure = await service.install(input({ shownRisks: shown })).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginConsentActStaleError);
      expect(failure).toMatchObject({
        pluginSlug: 'demo-sink',
        kind: 'risk',
        staleRisks: [
          { permissionSlug: 'read:audit_log', shownRiskLevel: RiskLevel.High, currentRiskLevel: RiskLevel.Critical },
        ],
      });
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('refuses as stale a server-scope permission it was sent no risk for (#1336)', async () => {
      const failure = await service.install(input({ shownRisks: CURRENT.slice(0, 1) })).catch((err: unknown) => err);

      expect(failure).toMatchObject({
        name: 'PluginConsentActStaleError',
        staleRisks: [{ permissionSlug: 'feedback:read', shownRiskLevel: null, currentRiskLevel: RiskLevel.Medium }],
      });
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('static-analysis gate', () => {
    const forbidden: StaticAnalysisFinding = {
      file: 'index.js',
      kind: 'esm-import',
      specifier: '@prisma/client',
      severity: 'forbidden',
      scanScope: 'default',
    };

    it('rejects on default-scope forbidden findings, carrying them on the error', async () => {
      analyzer.analyze.mockResolvedValue({
        findings: [forbidden],
        scannedFileCount: 1,
        deepScannedFileCount: 0,
        truncated: false,
      });

      const failure = await service.install(input()).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginInstallStaticAnalysisError);
      expect((failure as PluginInstallStaticAnalysisError).findings).toEqual([forbidden]);
      expect((failure as PluginInstallStaticAnalysisError).unacknowledgedSpecifiers).toEqual(['@prisma/client']);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('does NOT gate on warnings or deep-scan advisories — forbidden-in-vendored included', async () => {
      analyzer.analyze.mockResolvedValue({
        findings: [
          { ...forbidden, severity: 'warning' },
          { ...forbidden, scanScope: 'deep' },
        ],
        scannedFileCount: 1,
        deepScannedFileCount: 5,
        truncated: false,
      });

      await expect(service.install(input({ deepScan: true }))).resolves.toBeDefined();
    });

    it('records an empty acknowledgement on a clean install', async () => {
      const result = await service.install(input());

      expect(result.acknowledgedForbiddenImports).toEqual([]);
      expect(installedEvent().acknowledgedForbiddenImports).toEqual([]);
    });

    /**
     * The gate is a lint, not a sandbox, so an operator can accept the risk
     * on their own instance — but only per specifier, and always on the
     * record (#59).
     */
    describe('admin override', () => {
      const twoForbidden: StaticAnalysisReport = {
        findings: [forbidden, { ...forbidden, file: 'other.js', specifier: 'ioredis' }],
        scannedFileCount: 2,
        deepScannedFileCount: 0,
        truncated: false,
      };

      it('installs when every reported specifier is re-entered', async () => {
        analyzer.analyze.mockResolvedValue(twoForbidden);

        const result = await service.install(input({ acknowledgeForbiddenImports: ['@prisma/client', 'ioredis'] }));

        expect(result.acknowledgedForbiddenImports).toEqual(['@prisma/client', 'ioredis']);
        expect(db.plugin.create).toHaveBeenCalled();
      });

      it('still refuses a PARTIAL acknowledgement, naming what is outstanding', async () => {
        analyzer.analyze.mockResolvedValue(twoForbidden);

        const failure = await service
          .install(input({ acknowledgeForbiddenImports: ['@prisma/client'] }))
          .catch((err: unknown) => err);

        expect(failure).toBeInstanceOf(PluginInstallStaticAnalysisError);
        expect((failure as PluginInstallStaticAnalysisError).unacknowledgedSpecifiers).toEqual(['ioredis']);
        expect(db.$transaction).not.toHaveBeenCalled();
      });

      it('refuses an acknowledgement naming a specifier analysis did not report', async () => {
        analyzer.analyze.mockResolvedValue(twoForbidden);

        const failure = await service
          .install(input({ acknowledgeForbiddenImports: ['@prisma/client', 'ioredis', 'undici'] }))
          .catch((err: unknown) => err);

        expect(failure).toBeInstanceOf(PluginInstallStaticAnalysisError);
        expect((failure as PluginInstallStaticAnalysisError).unexpectedSpecifiers).toEqual(['undici']);
      });

      it('refuses an acknowledgement on a clean install — nothing to accept', async () => {
        await expect(service.install(input({ acknowledgeForbiddenImports: ['axios'] }))).rejects.toBeInstanceOf(
          PluginInstallStaticAnalysisError,
        );
      });

      it('accepts one specifier for many files — the decision is per specifier, not per site', async () => {
        analyzer.analyze.mockResolvedValue({
          findings: [forbidden, { ...forbidden, file: 'b.js' }, { ...forbidden, file: 'c.js' }],
          scannedFileCount: 3,
          deepScannedFileCount: 0,
          truncated: false,
        });

        const result = await service.install(input({ acknowledgeForbiddenImports: ['@prisma/client'] }));

        expect(result.acknowledgedForbiddenImports).toEqual(['@prisma/client']);
      });

      it('records the override on the install event, with the findings left intact', async () => {
        analyzer.analyze.mockResolvedValue(twoForbidden);

        await service.install(input({ acknowledgeForbiddenImports: ['@prisma/client', 'ioredis'] }));

        const event = installedEvent();
        expect(event.acknowledgedForbiddenImports).toEqual(['@prisma/client', 'ioredis']);
        // The report is NOT filtered to look clean — provenance shows what was let through.
        expect(event.staticAnalysis).toEqual(twoForbidden.findings);
      });

      it('does not let an acknowledgement wave through a DIFFERENT gate', async () => {
        analyzer.analyze.mockResolvedValue(twoForbidden);
        authority.isServerAdmin.mockResolvedValue(false);

        await expect(
          service.install(input({ acknowledgeForbiddenImports: ['@prisma/client', 'ioredis'] })),
        ).rejects.toBeInstanceOf(PluginInstallAuthorityError);
      });
    });
  });

  describe('persistence guards', () => {
    it('rejects an already-installed slug — updates are the C3 flow', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ id: 'existing' }));

      await expect(service.install(input())).rejects.toBeInstanceOf(PluginInstallConflictError);
      expect(db.plugin.create).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    describe('reinstall over a tombstone', () => {
      const tombstoned = (overrides: Partial<Plugin> = {}): Plugin =>
        makePlugin({
          id: 'existing',
          enabled: false,
          uninstalledAt: new Date('2026-08-01T00:00:00Z'),
          restartRequired: true,
          // Retained server config; the fixture schema allows a string webhookUrl.
          config: { webhookUrl: 'https://retained.example.test' },
          ...overrides,
        });

      beforeEach(() => {
        db.plugin.findUnique.mockResolvedValue(tombstoned());
        // The tombstone claim is a guarded write, so it goes through
        // updateMany and re-reads the row it won.
        db.plugin.updateMany.mockResolvedValue({ count: 1 });
        db.plugin.findUniqueOrThrow.mockResolvedValue(makePlugin({ id: 'existing', uninstalledAt: null }));
      });

      it('clears the tombstone in place instead of conflicting — uninstall and its inverse land together', async () => {
        const result = await service.install(input());

        expect(db.plugin.create).not.toHaveBeenCalled();
        expect(db.plugin.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            // Guarded on the tombstone still being there: a concurrent
            // reinstall must not overwrite the living row it produced.
            where: { id: 'existing', uninstalledAt: { not: null } },
            data: expect.objectContaining({
              uninstalledAt: null,
              enabled: false,
              restartRequired: true,
              version: '1.2.0',
              installedById: 'admin-1',
              pendingVersion: null,
              pendingSha256: null,
              pendingSince: null,
              pendingStagingId: null,
              pendingFromUrl: null,
              pendingRegistrySlug: null,
            }),
          }),
        );
        expect(result.plugin.uninstalledAt).toBeNull();
      });

      it('re-seeds the permission catalog and server grants — the uninstall purge made consent start from zero', async () => {
        await service.install(input());

        expect(db.pluginPermission.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ pluginId: 'existing' }) }),
        );
        expect(db.pluginGrant.upsert).toHaveBeenCalledWith(
          expect.objectContaining({ create: expect.objectContaining({ pluginId: 'existing' }) }),
        );
      });

      it('a reinstall over an uninstalled plugin writes a new act for its decisions (#1336)', async () => {
        db.pluginConsentAct.create.mockImplementation((({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'act-reinstall', createdAt: new Date(0), ...data })) as never);

        const result = await service.install(input());

        expect(db.pluginConsentAct.create).toHaveBeenCalledTimes(1);
        expect(db.pluginConsentAct.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            pluginId: 'existing',
            kind: PluginConsentActKind.InstallAccept,
            manifestSha256: sha('a'),
          }),
        });
        expect(result.act.id).toBe('act-reinstall');
        expect(db.pluginGrant.upsert).toHaveBeenCalledTimes(2);

        for (const [{ create }] of db.pluginGrant.upsert.mock.calls as unknown as [{ create: { actId: string } }][]) {
          expect(create.actId).toBe('act-reinstall');
        }
      });

      it('carries retained server config forward when it still satisfies the new schema', async () => {
        await service.install(input());

        const update = db.plugin.updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
        expect(update.data['config']).toEqual({ webhookUrl: 'https://retained.example.test' });
        expect(installedEvent().retainedConfigReset).toBe(false);
      });

      it('resets schema-invalid retained config to {} and records the reset on the event', async () => {
        db.plugin.findUnique.mockResolvedValue(tombstoned({ config: { webhookUrl: 42 } }));

        await service.install(input());

        const update = db.plugin.updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
        expect(update.data['config']).toEqual({});
        expect(installedEvent().retainedConfigReset).toBe(true);
      });

      it('writes the default execution mode explicitly when the manifest carries no hint — an update cannot lean on the column default', async () => {
        const manifest = buildPluginManifest();
        delete manifest.executionMode;
        await writeManifest(manifest);

        await service.install(input());

        const [{ data }] = db.plugin.updateMany.mock.calls[0] as [{ data: Record<string, unknown> }];
        expect(data['executionMode']).toBe(DEFAULT_PLUGIN_EXECUTION_MODE);
      });

      it('refuses when a concurrent reinstall cleared the tombstone first', async () => {
        db.plugin.updateMany.mockResolvedValue({ count: 0 });

        await expect(service.install(input())).rejects.toBeInstanceOf(PluginInstallConflictError);
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      it('a reinstall race has its own code (#1094)', async () => {
        db.plugin.updateMany.mockResolvedValue({ count: 0 });

        const failure = await service.install(input()).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(PluginReinstallConflictError);
        expect(failure).toBeInstanceOf(PluginInstallConflictError);
        expect((failure as Error).name).toBe('PluginReinstallConflictError');
      });

      it('a fresh install reports no reset — the flag is reinstall provenance only', async () => {
        db.plugin.findUnique.mockResolvedValue(null);

        await service.install(input());

        expect(installedEvent().retainedConfigReset).toBe(false);
      });

      it('never deletes or rewrites the retained household/user config — reinstall is what the tombstone preserved it for', async () => {
        db.householdPlugin.findMany.mockResolvedValue([householdRow()]);

        await service.install(input());

        expect(db.householdPlugin.deleteMany).not.toHaveBeenCalled();
        expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
        expect(db.userPlugin.deleteMany).not.toHaveBeenCalled();
        expect(db.userPlugin.updateMany).not.toHaveBeenCalled();
      });

      /**
       * A reinstall rewrites `scope` and `config.schema` from the new manifest,
       * and an uninstall with `purgeData: false` retained every household unit
       * enablement as it stood. Whether such a unit can run under the new
       * manifest is worked out when read, from the active manifest and the
       * unit's retained `config` (#1151), so the reinstall has nothing to read
       * or write on that axis — whichever way the manifest moved.
       */
      it.each([
        ['a server-scope manifest', buildPluginManifest({ scope: 'server' })],
        ['a household-scope manifest', buildPluginManifest({ scope: 'household' })],
        [
          'a household-scope manifest whose schema rejects the retained document',
          buildPluginManifest({
            scope: 'household',
            config: {
              schema: {
                type: 'object',
                properties: { webhookUrl: { type: 'string' }, apiKey: { type: 'string' } },
                required: ['webhookUrl', 'apiKey'],
              },
            },
          }),
        ],
      ])('a reinstall reads and writes no household unit enablement under %s (#1151)', async (_, manifest) => {
        db.householdPlugin.findMany.mockResolvedValue([householdRow()]);
        await writeManifest(manifest);

        await service.install(input());

        for (const method of Object.values(db.householdPlugin)) {
          expect(method).not.toHaveBeenCalled();
        }
      });

      it('leaves household rows alone on a FRESH install — there is no plugin row for one to reference', async () => {
        db.plugin.findUnique.mockResolvedValue(null);

        await service.install(input());

        expect(db.householdPlugin.findMany).not.toHaveBeenCalled();
        expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
      });
    });

    it('surfaces a declares collision from the catalog pre-check', async () => {
      db.pluginPermission.findMany.mockResolvedValue([makePluginPermission()]);

      const failure = await service.install(input()).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginInstallPermissionCollisionError);
      expect((failure as PluginInstallPermissionCollisionError).collidingSlugs).toEqual([
        'plugin|demo-sink|manage:digest',
      ]);
      expect(db.plugin.create).not.toHaveBeenCalled();
    });

    it('emits no event when any pipeline stage fails', async () => {
      authority.isServerAdmin.mockResolvedValue(false);
      await service.install(input()).catch(() => undefined);

      db.plugin.findUnique.mockResolvedValue(makePlugin({ id: 'existing' }));
      authority.isServerAdmin.mockResolvedValue(true);
      await service.install(input()).catch(() => undefined);

      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('the DataGateway row of a data-gateway plugin', () => {
    /** The rows the unique lookups find: by the plugin that owns one, and by the name one holds. */
    const dataGatewayRows = (found: { readonly byName?: string; readonly byPluginId?: string }): void => {
      db.dataGateway.findUnique.mockImplementation(((args: { where: { name?: string; pluginId?: string } }) => {
        const id = args.where.pluginId !== undefined ? found.byPluginId : found.byName;

        return Promise.resolve(id === undefined ? null : { id });
      }) as never);
    };

    const uninstalled = (): Plugin =>
      makePlugin({
        id: 'existing',
        category: PluginCategory.DataGateway,
        uninstalledAt: new Date('2026-08-01T00:00:00Z'),
        restartRequired: true,
      });

    /** Puts an uninstalled data-gateway plugin in place, the row it kept still on it. */
    const uninstalledWithItsRow = (): void => {
      db.plugin.findUnique.mockResolvedValue(uninstalled());
      db.plugin.updateMany.mockResolvedValue({ count: 1 });
      db.plugin.findUniqueOrThrow.mockResolvedValue(makePlugin({ id: 'existing', uninstalledAt: null }));
      db.dataGateway.updateMany.mockResolvedValue({ count: 1 });
    };

    beforeEach(async () => {
      await writeManifest(
        buildPluginManifest({ category: 'data-gateway', displayName: { en: 'Demo Gateway', de: 'Demo-Gateway' } }),
      );
      db.plugin.create.mockResolvedValue(makePlugin({ category: PluginCategory.DataGateway }));
      dataGatewayRows({});
      db.dataGateway.updateMany.mockResolvedValue({ count: 0 });
      db.dataGateway.create.mockResolvedValue({ id: 'gw-1' } as never);
    });

    it('creates the DataGateway row for a data-gateway plugin (#1083)', async () => {
      await service.install(input());

      // Named from the display name in the server default locale (`en` here),
      // with none of a remote DataGateway's connection fields.
      expect(db.dataGateway.create).toHaveBeenCalledWith({
        data: { name: 'Demo Gateway', pluginId: 'plugin-1', enabled: true, createdById: 'admin-1' },
      });
      // In the install's transaction, once the plugin row it names exists.
      expect(db.plugin.create.mock.invocationCallOrder[0]).toBeLessThan(
        db.dataGateway.create.mock.invocationCallOrder[0],
      );
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    });

    it('creates none for another category (#1083)', async () => {
      await writeManifest(buildPluginManifest());
      db.plugin.create.mockResolvedValue(makePlugin());

      await service.install(input());

      expect(db.dataGateway.create).not.toHaveBeenCalled();
      expect(db.dataGateway.updateMany).not.toHaveBeenCalled();
      expect(db.dataGateway.findUnique).not.toHaveBeenCalled();
    });

    it('a reinstall enables the row it kept (#1083)', async () => {
      uninstalledWithItsRow();
      dataGatewayRows({ byPluginId: 'gw-kept' });

      await service.install(input());

      expect(db.dataGateway.updateMany).toHaveBeenCalledWith({
        where: { pluginId: 'existing' },
        data: { enabled: true },
      });
      expect(db.dataGateway.create).not.toHaveBeenCalled();
    });

    // installedAt names the install. A reinstall keeps the plugin's id, so
    // without a new installedAt the copy of the plugin loaded before the
    // uninstall would still count as this install's, and its DataGateway would
    // be routed to it. An update keeps installedAt (#1083).
    it("a reinstall writes a new installedAt, so the copy loaded before the uninstall isn't taken for this install (#1083)", async () => {
      uninstalledWithItsRow();
      dataGatewayRows({ byPluginId: 'gw-kept' });
      const before = Date.now();

      await service.install(input());

      const [claim] = db.plugin.updateMany.mock.calls[0];
      expect(claim.where).toEqual({ id: 'existing', uninstalledAt: { not: null } });
      expect(claim.data.installedAt).toBeInstanceOf(Date);
      expect((claim.data.installedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    });

    it('a name in use refuses the install and writes nothing (#1083)', async () => {
      dataGatewayRows({ byName: 'gw-other' });

      const failure = await service.install(input()).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PluginInstallDataGatewayNameConflictError);
      expect(failure).toMatchObject({ slug: 'demo-sink', dataGatewayName: 'Demo Gateway' });
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.plugin.create).not.toHaveBeenCalled();
      expect(db.dataGateway.create).not.toHaveBeenCalled();
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('a name taken after the assessment still refuses the install, inside its transaction (#1083)', async () => {
      // The assessment's read found the name free; a row took it before the
      // install's transaction ran.
      db.dataGateway.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'gw-other' } as never)
        .mockResolvedValue(null);
      db.plugin.findUnique.mockResolvedValue(null);

      await expect(service.install(input())).rejects.toBeInstanceOf(PluginInstallDataGatewayNameConflictError);
      // Thrown inside the transaction, so the plugin row written before it rolls back.
      await expect(db.$transaction.mock.results[0]?.value).rejects.toBeInstanceOf(
        PluginInstallDataGatewayNameConflictError,
      );
      expect(db.dataGateway.create).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('assess reports a name in use and still returns the assessment (#1083)', async () => {
      dataGatewayRows({ byName: 'gw-other' });

      const assessment = await service.assess(directory());

      expect(assessment.dataGatewayNameConflict).toBe('Demo Gateway');
      expect(assessment.validated.manifest.slug).toBe('demo-sink');
      expect(assessment.serverChecks).toHaveLength(2);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('a live plugin of another category under the slug is refused as already installed, not as a taken name (#1083)', async () => {
      // The install would never get as far as creating a row: the slug is
      // installed and live, so the true refusal is the update flow's.
      db.plugin.findUnique.mockResolvedValue(makePlugin({ id: 'existing', category: PluginCategory.FeedbackSink }));
      dataGatewayRows({ byName: 'gw-other' });

      const assessment = await service.assess(directory());
      const failure = await service.install(input()).catch((error: unknown) => error);

      expect(assessment.dataGatewayNameConflict).toBeNull();
      expect(failure).toBeInstanceOf(PluginInstallConflictError);
      expect((failure as Error).name).toBe('PluginInstallConflictError');
      expect(db.dataGateway.create).not.toHaveBeenCalled();
    });

    it('assess reports no conflict when the name is free (#1083)', async () => {
      const assessment = await service.assess(directory());

      expect(assessment.dataGatewayNameConflict).toBeNull();
    });

    it('a reinstall under the same name as its own row reports no conflict (#1083)', async () => {
      uninstalledWithItsRow();
      dataGatewayRows({ byPluginId: 'gw-kept', byName: 'gw-kept' });

      const assessment = await service.assess(directory());

      expect(assessment.dataGatewayNameConflict).toBeNull();
      await expect(service.install(input())).resolves.toBeDefined();
    });

    it("a reinstall reports no conflict when its kept row was renamed and another row took the manifest's name since (#1083)", async () => {
      // The reinstall creates no row, so it never meets the name, and the
      // artifact step must not report a conflict the install would not hit.
      uninstalledWithItsRow();
      dataGatewayRows({ byPluginId: 'gw-kept', byName: 'gw-other' });

      const assessment = await service.assess(directory());

      expect(assessment.dataGatewayNameConflict).toBeNull();
      await expect(service.install(input())).resolves.toBeDefined();
      expect(db.dataGateway.create).not.toHaveBeenCalled();
    });

    it('assess reports no conflict for another category, and reads no DataGateway row (#1083)', async () => {
      await writeManifest(buildPluginManifest());
      dataGatewayRows({ byName: 'gw-other' });

      const assessment = await service.assess(directory());

      expect(assessment.dataGatewayNameConflict).toBeNull();
      expect(db.dataGateway.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('per-unit consent stays per-unit', () => {
    it('seeds NOTHING for household- and user-consentable checks', async () => {
      const manifest = buildPluginManifest({ scope: 'household' });
      manifest.permissions.checks = [
        ...manifest.permissions.checks,
        {
          slug: 'update:calendar',
          required: false,
          reason: { en: 'Writes digest reminders to the household calendar.' },
          consentScope: 'household',
        },
        {
          slug: 'read:public_content',
          required: false,
          reason: { en: 'Shows public content excerpts inside per-user digests.' },
          consentScope: 'user',
        },
      ];
      await writeManifest(manifest);
      db.permission.findMany.mockResolvedValue([
        feedbackRead,
        // Unit-consented checks must name conditioned rows to pass the
        // unit-boundedness gate (#60); these fixtures model the seeded
        // unit-conditioned variants.
        {
          slug: 'update:calendar',
          ...UNIT_BOUND_RULES.Household,
          riskLevel: RiskLevel.Low,
        } as unknown as Permission,
        {
          slug: 'read:public_content',
          ...UNIT_BOUND_RULES.User,
          riskLevel: RiskLevel.Low,
        } as unknown as Permission,
      ]);

      const result = await service.install(input());

      // Asserted on the issued upserts: the delegate mock returns a fixed
      // row, and "seeds nothing for these scopes" is a claim about writes.
      const seeded = (permissionSlug: string) =>
        expect.objectContaining({ create: expect.objectContaining({ permissionSlug }) });

      expect(db.pluginGrant.upsert).toHaveBeenCalledTimes(2);
      expect(db.pluginGrant.upsert).toHaveBeenCalledWith(seeded('plugin|demo-sink|manage:digest'));
      expect(db.pluginGrant.upsert).toHaveBeenCalledWith(seeded('feedback:read'));
      expect(db.pluginGrant.upsert).not.toHaveBeenCalledWith(seeded('update:calendar'));
      expect(db.pluginGrant.upsert).not.toHaveBeenCalledWith(seeded('read:public_content'));
      expect(result.seededGrants).toHaveLength(2);
    });
  });
});
