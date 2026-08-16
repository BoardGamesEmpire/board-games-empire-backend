import {
  PluginCategory,
  PluginExecutionMode,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  RiskLevel,
  type DatabaseService,
  type Permission,
  type Plugin,
  type PluginGrant,
  type PluginPermission,
} from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import type { InstalledPluginDirectory } from '@boardgamesempire/plugin-contract';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginInstalledEvent } from '../events/plugin.events';
import { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import { SERVER_SCOPE_SENTINEL } from '@bge/database';
import type { PluginModuleOptions } from '../plugin-module.options';
import {
  PluginInstallAuthorityError,
  PluginInstallConflictError,
  PluginInstallCriticalConfirmationError,
  PluginInstallForbiddenPermissionError,
  PluginInstallManifestError,
  PluginInstallPermissionCollisionError,
  PluginInstallProvenanceMismatchError,
  PluginInstallStaticAnalysisError,
  PluginInstallUnknownCorePermissionError,
} from './install.errors';
import { PluginInstallerService, type PluginInstallInput } from './plugin-installer.service';
import { PluginStaticAnalysisService } from './plugin-static-analysis.service';
import type { StaticAnalysisFinding, StaticAnalysisReport } from './static-analysis.types';

describe('PluginInstallerService', () => {
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

  const makePlugin = (overrides: Partial<Plugin> = {}): Plugin => ({
    id: 'plugin-1',
    slug: 'demo-sink',
    version: '1.2.0',
    category: PluginCategory.FeedbackSink,
    scope: PluginScope.Server,
    executionMode: PluginExecutionMode.InProcess,
    enabled: false,
    bundled: false,
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
    installedSha256: null,
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
    manifestVersion: '1.2.0',
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
  let service: PluginInstallerService;

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

  /**
   * The fixture's checks: `manage:digest` (plugin-declared, server consent,
   * required) and `feedback:read` (core, server consent, optional). The
   * core row is classified Medium here so risk propagation is observable.
   */
  const feedbackRead = { slug: 'feedback:read', subject: 'feedback', riskLevel: RiskLevel.Medium } as Permission;

  const input = (overrides: Partial<PluginInstallInput> = {}): PluginInstallInput => ({
    directory: directory(),
    provenance: {
      bundled: false,
      installedSha256: 'sha-256-digest',
      installedFromUrl: 'https://registry.example/demo-sink-1.2.0.tgz',
      registrySlug: 'bge-official',
    },
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
    db.pluginGrant.create.mockResolvedValue(makePluginGrant());
    db.permission.findMany.mockResolvedValue([feedbackRead]);

    authority = { isServerAdmin: jest.fn() } satisfies Partial<jest.Mocked<PluginGrantAuthorityService>> as jest.Mocked<
      Pick<PluginGrantAuthorityService, 'isServerAdmin'>
    >;
    authority.isServerAdmin.mockResolvedValue(true);

    analyzer = { analyze: jest.fn() } satisfies Partial<jest.Mocked<PluginStaticAnalysisService>> as jest.Mocked<
      Pick<PluginStaticAnalysisService, 'analyze'>
    >;
    analyzer.analyze.mockResolvedValue(emptyReport);

    emitter = { emit: jest.fn() };

    service = new PluginInstallerService(
      db as unknown as DatabaseService,
      authority as unknown as PluginGrantAuthorityService,
      analyzer as unknown as PluginStaticAnalysisService,
      emitter as unknown as EventEmitter2,
      options,
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
          bundled: false,
          installedFromUrl: 'https://registry.example/demo-sink-1.2.0.tgz',
          installedSha256: 'sha-256-digest',
          registrySlug: 'bge-official',
          installedById: 'admin-1',
          manifestJson: expect.objectContaining({ slug: 'demo-sink', version: '1.2.0' }),
        }),
      });
      expect(result.plugin.id).toBe('plugin-1');
      expect(result.warnings).toEqual([]);
      expect(result.analysis).toBe(emptyReport);
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

      expect(db.pluginGrant.create).toHaveBeenCalledTimes(2);
      expect(db.pluginGrant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pluginId: 'plugin-1',
          scopeType: PluginGrantScope.Server,
          scopeId: SERVER_SCOPE_SENTINEL,
          permissionSlug: 'plugin|demo-sink|manage:digest',
          status: PluginGrantStatus.Granted,
          manifestVersion: '1.2.0',
          decidedById: 'admin-1',
          decidedRiskLevel: RiskLevel.Low,
        }),
      });
      expect(db.pluginGrant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          permissionSlug: 'feedback:read',
          // Core risk propagates from the Permission row into decidedRiskLevel — the baseline
          // update-time risk escalation compares against (#59).
          decidedRiskLevel: RiskLevel.Medium,
        }),
      });
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
        bundled: false,
      });
      expect(event.provenance).toEqual({
        installedFromUrl: 'https://registry.example/demo-sink-1.2.0.tgz',
        installedSha256: 'sha-256-digest',
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

  describe('bundled installs', () => {
    it('persists null provenance columns and a null-field event provenance', async () => {
      await service.install(input({ directory: directory(true), provenance: { bundled: true } }));

      expect(db.plugin.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bundled: true,
          installedFromUrl: null,
          installedSha256: null,
          registrySlug: null,
        }),
      });
      expect(installedEvent().provenance).toEqual({
        installedFromUrl: null,
        installedSha256: null,
        registrySlug: null,
      });
    });

    it('still runs static analysis — first-party code obeys the same import rules', async () => {
      await service.install(input({ directory: directory(true), provenance: { bundled: true } }));

      expect(analyzer.analyze).toHaveBeenCalledWith(directory(true), { deepScan: false });
    });

    it('rejects a provenance/directory bundled mismatch as corrupted pipeline state', async () => {
      await expect(service.install(input({ directory: directory(true) }))).rejects.toBeInstanceOf(
        PluginInstallProvenanceMismatchError,
      );
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('manifest gate', () => {
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
        expect(db.pluginGrant.create).not.toHaveBeenCalled();
      });

      it('grants it on confirmation, with the Critical risk captured on the row', async () => {
        await withCriticalCheck(false);

        await service.install(input({ confirmCriticalSlugs: ['read:audit_log'] }));

        expect(db.pluginGrant.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            permissionSlug: 'read:audit_log',
            status: PluginGrantStatus.Granted,
            decidedRiskLevel: RiskLevel.Critical,
          }),
        });
      });
    });

    it('demands nothing when no Critical permission is requested at all', async () => {
      await expect(service.install(input())).resolves.toBeDefined();
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
          subject: 'calendar',
          riskLevel: RiskLevel.Low,
          conditions: { householdId: '{{ unit.householdId }}' },
        } as unknown as Permission,
        {
          slug: 'read:public_content',
          subject: 'public_content',
          riskLevel: RiskLevel.Low,
          conditions: { ownerId: '{{ unit.userId }}' },
        } as unknown as Permission,
      ]);

      const result = await service.install(input());

      // Asserted on the issued creates: the delegate mock returns a fixed
      // row, and "seeds nothing for these scopes" is a claim about writes.
      expect(db.pluginGrant.create).toHaveBeenCalledTimes(2);
      expect(db.pluginGrant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ permissionSlug: 'plugin|demo-sink|manage:digest' }),
      });
      expect(db.pluginGrant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ permissionSlug: 'feedback:read' }),
      });
      expect(db.pluginGrant.create).not.toHaveBeenCalledWith({
        data: expect.objectContaining({ permissionSlug: 'update:calendar' }),
      });
      expect(db.pluginGrant.create).not.toHaveBeenCalledWith({
        data: expect.objectContaining({ permissionSlug: 'read:public_content' }),
      });
      expect(result.seededGrants).toHaveLength(2);
    });
  });
});
