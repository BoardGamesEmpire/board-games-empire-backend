import type { AuditContextService } from '@bge/actor-context';
import { Action, ResourceType } from '@bge/database';
import { CHECK_POLICIES_KEY, PoliciesGuard, type AppAbility } from '@bge/permissions';
import type { PluginInventoryService } from '@bge/plugin';
import { createMockAbilityService, MOCK_ACTING_USER_ID, type MockAbilityService } from '@bge/testing';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { PluginArtifactSourceError } from './plugin-artifact-source.error';
import { PluginArtifactsController } from './plugin-artifacts.controller';

const SHA = 'a'.repeat(64);
const EXPIRES = new Date('2026-11-12T00:00:00.000Z');

const manifest = {
  slug: 'demo-sink',
  version: '1.2.0',
  bgeCompat: '>=1.0.0',
  category: 'integration',
  scope: 'server',
  displayName: { en: 'Demo Sink', de: 'Demo-Senke' },
  description: { en: 'Sinks events', de: 'Schluckt Ereignisse' },
  features: [{ name: 'digest', displayName: { en: 'Digest', de: 'Zusammenfassung' }, description: { en: 'Weekly' } }],
  network: { outboundDomains: ['example.test'] },
};

const receipt = (state: 'none' | 'installed' | 'uninstalled' = 'none') => ({
  artifact: {
    sha256: SHA,
    slug: 'demo-sink',
    version: '1.2.0',
    compressedBytes: 1234,
    url: 'https://example.test/demo-sink.tgz',
    registrySlug: null,
    expiresAt: EXPIRES,
  },
  directory: {},
  assessment: {
    validated: {
      manifest,
      warnings: [],
      permissionChecks: [
        {
          slug: 'manage:game',
          canonicalSlug: 'manage:game',
          origin: 'core',
          required: true,
          consentScope: 'server',
          reason: { en: 'Keeps games in sync', de: 'Hält Spiele aktuell' },
        },
      ],
    },
    corePermissions: new Map([['manage:game', { riskLevel: 'High' }]]),
    criticalSlugsToReenter: ['manage:game'],
    forbiddenImportsToAccept: ['axios'],
    analysis: { findings: [], scannedFileCount: 3, deepScannedFileCount: 0, truncated: false },
  },
  installedPlugin: { state, version: state === 'none' ? null : '1.0.0' },
});

const UPLOADED = { path: '/plugins/.incoming/x.tgz', size: 4096, sha256: 'b'.repeat(64) } as never;

describe('PluginArtifactsController (#1094)', () => {
  let controller: PluginArtifactsController;
  let receiver: { receiveByLink: jest.Mock; receiveUpload: jest.Mock; read: jest.Mock };
  let installer: { install: jest.Mock };
  let inventory: jest.Mocked<Pick<PluginInventoryService, 'getBySlug'>>;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getLocale'>>;
  let abilityService: MockAbilityService;

  const build = (defaultLocale: string) =>
    new PluginArtifactsController(
      receiver as never,
      installer as never,
      inventory as never,
      abilityService as never,
      auditContext as never,
      { defaultLocale } as never,
    );

  beforeEach(() => {
    receiver = {
      receiveByLink: jest.fn().mockResolvedValue(receipt()),
      receiveUpload: jest.fn().mockResolvedValue(receipt()),
      read: jest.fn().mockResolvedValue(receipt('installed')),
    };
    installer = { install: jest.fn().mockResolvedValue({ plugin: { slug: 'demo-sink' } }) };
    inventory = { getBySlug: jest.fn().mockResolvedValue({ slug: 'demo-sink', executionMode: 'InProcess' } as never) };
    auditContext = { getLocale: jest.fn().mockReturnValue(null) };
    abilityService = createMockAbilityService();
    controller = new PluginArtifactsController(
      receiver as never,
      installer as never,
      inventory as never,
      abilityService as never,
      auditContext as never,
      { defaultLocale: 'en' } as never,
    );
  });

  afterEach(() => jest.clearAllMocks());

  describe('POST /plugins/artifacts', () => {
    it('downloads a posted link as the acting server admin and answers with what the artifact asks for (#1094)', async () => {
      const result = await firstValueFrom(controller.post({ url: 'https://example.test/demo-sink.tgz', sha256: SHA }));

      expect(receiver.receiveByLink).toHaveBeenCalledWith({
        url: 'https://example.test/demo-sink.tgz',
        expectedSha256: SHA,
        actorId: MOCK_ACTING_USER_ID,
      });
      expect(receiver.receiveUpload).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          artifact: expect.objectContaining({ sha256: SHA, slug: 'demo-sink', expiresAt: EXPIRES }),
          criticalSlugsToReenter: ['manage:game'],
          forbiddenImportsToAccept: ['axios'],
          analysis: { findings: [], truncated: false, scannedFileCount: 3 },
          warnings: [],
          installedPlugin: { state: 'none', version: null },
        }),
      );
    });

    it('hands an upload to the receiver with the counted checksum and size (#1094)', async () => {
      await firstValueFrom(controller.post({ sha256: SHA }, UPLOADED));

      expect(receiver.receiveUpload).toHaveBeenCalledWith({
        archivePath: '/plugins/.incoming/x.tgz',
        sha256: 'b'.repeat(64),
        bytes: 4096,
        expectedSha256: SHA,
        actorId: MOCK_ACTING_USER_ID,
      });
      expect(receiver.receiveByLink).not.toHaveBeenCalled();
    });

    it('a link and a file together are refused with PluginArtifactSourceError (#1094)', () => {
      expect(() => controller.post({ url: 'https://example.test/x.tgz', sha256: SHA }, UPLOADED)).toThrow(
        PluginArtifactSourceError,
      );
      expect(receiver.receiveByLink).not.toHaveBeenCalled();
      expect(receiver.receiveUpload).not.toHaveBeenCalled();
    });

    it('says both when a link and a file arrive together (#1094)', () => {
      expect.assertions(1);
      try {
        controller.post({ url: 'https://example.test/x.tgz', sha256: SHA }, UPLOADED);
      } catch (error) {
        expect((error as PluginArtifactSourceError).reason).toBe('both');
      }
    });

    it('neither a link nor a file is refused with PluginArtifactSourceError none (#1094)', async () => {
      const refused = await firstValueFrom(controller.post({ sha256: SHA })).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(PluginArtifactSourceError);
      expect((refused as PluginArtifactSourceError).reason).toBe('none');
      expect(receiver.receiveByLink).not.toHaveBeenCalled();
      expect(receiver.receiveUpload).not.toHaveBeenCalled();
    });

    it('localizes the manifest text and the checks with the request locale (#1094)', async () => {
      auditContext.getLocale.mockReturnValue('de');
      const german = await firstValueFrom(controller.post({ url: 'https://example.test/x.tgz', sha256: SHA }));

      expect(german.manifest.displayName).toBe('Demo-Senke');
      expect(german.manifest.features[0]).toEqual({
        name: 'digest',
        displayName: 'Zusammenfassung',
        description: 'Weekly',
      });
      expect(german.checks[0]?.reason.value).toBe('Hält Spiele aktuell');
    });

    it('falls back to the module default locale when the request has none (#1094)', async () => {
      auditContext.getLocale.mockReturnValue(null);
      const german = await firstValueFrom(build('de').post({ url: 'https://example.test/x.tgz', sha256: SHA }));

      expect(german.manifest.displayName).toBe('Demo-Senke');
      expect(german.checks[0]?.reason.value).toBe('Hält Spiele aktuell');
      expect(german.manifest.executionMode).toBe('in-process');
    });

    it('answers the execution mode the manifest names (#1094)', async () => {
      const worker = receipt();
      worker.assessment.validated.manifest = { ...manifest, executionMode: 'worker' } as typeof manifest;
      receiver.receiveByLink.mockResolvedValue(worker);

      const result = await firstValueFrom(controller.post({ url: 'https://example.test/x.tgz', sha256: SHA }));

      expect(result.manifest.executionMode).toBe('worker');
    });

    it.each([undefined, null, ''])('treats a url of %p beside a file as an upload (#1094)', async (url) => {
      await firstValueFrom(controller.post({ sha256: SHA, url: url as never }, UPLOADED));

      expect(receiver.receiveUpload).toHaveBeenCalled();
      expect(receiver.receiveByLink).not.toHaveBeenCalled();
    });

    it.each([null, ''])('treats a url of %p with no file as none, not a link (#1094)', async (url) => {
      const refused = await firstValueFrom(controller.post({ sha256: SHA, url: url as never })).catch(
        (error: unknown) => error,
      );

      expect(refused).toBeInstanceOf(PluginArtifactSourceError);
      expect((refused as PluginArtifactSourceError).reason).toBe('none');
      expect(receiver.receiveByLink).not.toHaveBeenCalled();
    });

    it('answers 200, not 201, because the post may only find what is already there (#1094)', () => {
      expect(Reflect.getMetadata('__httpCode__', PluginArtifactsController.prototype.post)).toBe(200);
    });
  });

  describe('GET /plugins/artifacts/:sha256', () => {
    it('reads the artifact back as the acting server admin with the same body (#1094)', async () => {
      const result = await firstValueFrom(controller.read(SHA));

      expect(receiver.read).toHaveBeenCalledWith(SHA, MOCK_ACTING_USER_ID);
      expect(result.installedPlugin).toEqual({ state: 'installed', version: '1.0.0' });
      expect(result.artifact.sha256).toBe(SHA);
    });

    it('cuts a route value past 128 characters so the not-found answer cannot echo it (#1094)', async () => {
      await firstValueFrom(controller.read('z'.repeat(5000)));

      expect(receiver.read).toHaveBeenCalledWith('z'.repeat(128), MOCK_ACTING_USER_ID);
    });

    it('passes a route value of exactly 128 characters as it is (#1094)', async () => {
      await firstValueFrom(controller.read('y'.repeat(128)));

      expect(receiver.read).toHaveBeenCalledWith('y'.repeat(128), MOCK_ACTING_USER_ID);
    });
  });

  describe('POST /plugins/install', () => {
    it('installs by checksum as the acting server admin with the confirmations it was sent (#1094)', async () => {
      await firstValueFrom(
        controller.install({
          sha256: SHA,
          confirmCriticalSlugs: ['manage:game'],
          acknowledgeForbiddenImports: ['axios'],
          deepScan: true,
        }),
      );

      expect(installer.install).toHaveBeenCalledWith({
        sha256: SHA,
        actorId: MOCK_ACTING_USER_ID,
        confirmCriticalSlugs: ['manage:game'],
        acknowledgeForbiddenImports: ['axios'],
        deepScan: true,
      });
    });

    it('answers with the new plugin read back through the inventory, in the request locale (#1094)', async () => {
      auditContext.getLocale.mockReturnValue('de');

      const result = await firstValueFrom(controller.install({ sha256: SHA }));

      expect(inventory.getBySlug).toHaveBeenCalledWith('demo-sink', 'de');
      expect(result).toEqual({ plugin: { slug: 'demo-sink', executionMode: 'InProcess' } });
    });

    it('answers 201, the default for a POST that creates (#1094)', () => {
      expect(Reflect.getMetadata('__httpCode__', PluginArtifactsController.prototype.install)).toBeUndefined();
    });
  });

  describe('policy gates', () => {
    const policiesFor = (handler: string) =>
      Reflect.getMetadata(CHECK_POLICIES_KEY, PluginArtifactsController.prototype[handler as never]) as
        | Array<(ability: AppAbility) => boolean>
        | undefined;

    it.each(['post', 'read', 'install'] as const)('%s needs manage:plugin (#1094)', (handler) => {
      const policies = policiesFor(handler);
      const can = jest.fn().mockReturnValue(true);

      expect(policies).toHaveLength(1);
      expect(policies?.[0]({ can } as unknown as AppAbility)).toBe(true);
      expect(can.mock.calls).toEqual([[Action.manage, ResourceType.Plugin]]);
    });

    // PoliciesGuard is not global, so the class-level guard is what makes the
    // route policies above count at all.
    it('attaches PoliciesGuard at the class level, so the policies are evaluated (#1094)', () => {
      expect(Reflect.getMetadata('__guards__', PluginArtifactsController)).toContain(PoliciesGuard);
    });

    it('every route carries a gate, so a new one cannot ship ungated (#1094)', () => {
      const routes = Object.getOwnPropertyNames(PluginArtifactsController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.getMetadata('path', PluginArtifactsController.prototype[name as never]) !== undefined,
      );

      expect(routes.sort()).toEqual(['install', 'post', 'read']);
      expect(routes.filter((name) => policiesFor(name) === undefined)).toEqual([]);
    });
  });
});
