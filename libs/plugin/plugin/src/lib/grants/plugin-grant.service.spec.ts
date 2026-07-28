import {
  DatabaseService,
  PluginGrantScope,
  PluginGrantStatus,
  RiskLevel,
  type Permission,
  type Plugin,
  type PluginGrant,
  type PluginPermission,
} from '@bge/database';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginEvent } from '../events/constants';
import { PluginGrantCreatedEvent, PluginGrantRejectedEvent } from '../events/plugin.events';
import type { PluginModuleOptions } from '../plugin-module.options';
import {
  PluginGrantAuthorityError,
  PluginGrantConsentScopeMismatchError,
  PluginGrantExclusionError,
  PluginGrantManifestInvalidError,
  PluginGrantPluginNotFoundError,
  PluginGrantScopeIdError,
  PluginGrantScopeNotRevocableError,
  PluginGrantUnknownPermissionError,
} from './grant.errors';
import { PluginGrantAuthorityService } from './plugin-grant-authority.service';
import { PluginGrantService } from './plugin-grant.service';

describe('PluginGrantService', () => {
  const options: PluginModuleOptions = {
    pluginsRoot: '/var/lib/bge/plugins',
    bundledRoot: '/srv/bge/plugins/bundled',
    bgeVersion: '0.3.0',
    defaultLocale: 'en',
  };

  /**
   * Household-scope manifest so every consent scope is exercisable:
   * `manage:digest` (declared, server consent), `feedback:read` (core,
   * server consent), plus household- and user-consented core checks.
   */
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

  const plugin = {
    id: 'plg_1',
    slug: 'demo-sink',
    version: '1.2.0',
    manifestJson: manifest,
  } as unknown as Plugin;

  const grantRow = (overrides: Partial<PluginGrant> = {}): PluginGrant =>
    ({
      id: 'grant_1',
      pluginId: 'plg_1',
      scopeType: PluginGrantScope.Server,
      scopeId: '',
      permissionSlug: 'feedback:read',
      status: PluginGrantStatus.Granted,
      decidedById: 'user-admin',
      manifestVersion: '1.2.0',
      decidedAt: new Date('2026-07-27T00:00:00.000Z'),
      decidedRiskLevel: RiskLevel.Medium,
      createdAt: new Date('2026-07-27T00:00:00.000Z'),
      updatedAt: new Date('2026-07-27T00:00:00.000Z'),
      ...overrides,
    }) as PluginGrant;

  let db: MockDatabaseService;
  let emitter: { emit: jest.Mock };
  let authority: jest.Mocked<
    Pick<PluginGrantAuthorityService, 'isServerAdmin' | 'isHouseholdAdmin' | 'hasQualifyingHouseholdForPlugin'>
  >;
  let service: PluginGrantService;

  beforeEach(() => {
    db = createMockDatabaseService();
    db.$transaction.mockImplementation((cb) => cb(db));
    db.plugin.findUnique.mockResolvedValue(plugin);
    db.permission.findUnique.mockResolvedValue({
      slug: 'feedback:read',
      subject: 'FeedbackSubmission',
      riskLevel: RiskLevel.Medium,
    } as Permission);
    db.pluginPermission.findUnique.mockResolvedValue({
      id: 'plgperm_1',
      pluginId: 'plg_1',
      slug: 'plugin|demo-sink|manage:digest',
      riskLevel: RiskLevel.Low,
    } as PluginPermission);
    db.pluginGrant.findUnique.mockResolvedValue(null);
    db.pluginGrant.upsert.mockResolvedValue(grantRow());

    emitter = { emit: jest.fn() };
    authority = {
      isServerAdmin: jest.fn(),
      isHouseholdAdmin: jest.fn(),
      hasQualifyingHouseholdForPlugin: jest.fn(),
    } satisfies Partial<jest.Mocked<PluginGrantAuthorityService>> as jest.Mocked<
      Pick<PluginGrantAuthorityService, 'isServerAdmin' | 'isHouseholdAdmin' | 'hasQualifyingHouseholdForPlugin'>
    >;
    authority.isServerAdmin.mockResolvedValue(true);
    authority.isHouseholdAdmin.mockResolvedValue(true);
    authority.hasQualifyingHouseholdForPlugin.mockResolvedValue(true);

    service = new PluginGrantService(
      db as unknown as DatabaseService,
      authority as unknown as PluginGrantAuthorityService,
      emitter as unknown as EventEmitter2,
      options,
    );
  });

  const serverDecision = {
    pluginId: 'plg_1',
    scopeType: PluginGrantScope.Server,
    permissionSlug: 'feedback:read',
    status: PluginGrantStatus.Granted,
    deciderId: 'user-admin',
  } as const;

  describe('decide — happy paths', () => {
    it('creates a Server-scope grant with the sentinel scopeId, the manifest version, and the resolved core risk', async () => {
      const result = await service.decide(serverDecision);

      expect(result.changed).toBe(true);
      expect(db.pluginGrant.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            pluginId: 'plg_1',
            scopeType: PluginGrantScope.Server,
            scopeId: '',
            permissionSlug: 'feedback:read',
            status: PluginGrantStatus.Granted,
            decidedById: 'user-admin',
            manifestVersion: '1.2.0',
            decidedRiskLevel: RiskLevel.Medium,
          }),
          update: expect.objectContaining({ status: PluginGrantStatus.Granted, decidedRiskLevel: RiskLevel.Medium }),
        }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(PluginEvent.GrantCreated, expect.any(PluginGrantCreatedEvent));
    });

    it('resolves plugin-declared risk from the PluginPermission catalog for canonical own-namespace slugs', async () => {
      await service.decide({ ...serverDecision, permissionSlug: 'plugin|demo-sink|manage:digest' });

      expect(db.pluginPermission.findUnique).toHaveBeenCalledWith({
        where: { slug: 'plugin|demo-sink|manage:digest' },
      });
      expect(db.pluginGrant.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ decidedRiskLevel: RiskLevel.Low }) }),
      );
    });

    it('a denial writes a Denied row and emits the rejection event', async () => {
      await service.decide({ ...serverDecision, status: PluginGrantStatus.Denied });

      expect(emitter.emit).toHaveBeenCalledWith(PluginEvent.GrantRejected, expect.any(PluginGrantRejectedEvent));
    });

    it('a polarity flip updates the existing row in place and emits with the prior snapshot', async () => {
      db.pluginGrant.findUnique.mockResolvedValue(grantRow({ status: PluginGrantStatus.Denied }));

      const result = await service.decide(serverDecision);

      expect(result.changed).toBe(true);
      expect(db.pluginGrant.upsert).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginEvent.GrantCreated,
        expect.objectContaining({ before: expect.objectContaining({ status: PluginGrantStatus.Denied }) }),
      );
    });

    it('an exact re-statement is idempotent: no write, no event', async () => {
      db.pluginGrant.findUnique.mockResolvedValue(grantRow());

      const result = await service.decide(serverDecision);

      expect(result.changed).toBe(false);
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('re-consent against a NEW manifest version rewrites the row even when the polarity is unchanged', async () => {
      db.pluginGrant.findUnique.mockResolvedValue(grantRow({ manifestVersion: '1.1.0' }));

      const result = await service.decide(serverDecision);

      expect(result.changed).toBe(true);
      expect(db.pluginGrant.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ manifestVersion: '1.2.0' }) }),
      );
    });
  });

  describe('decide — authority', () => {
    it('rejects a Server-scope decision from a non-admin', async () => {
      authority.isServerAdmin.mockResolvedValue(false);

      await expect(service.decide(serverDecision)).rejects.toThrow(PluginGrantAuthorityError);
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
    });

    it('Household-scope decisions verify owner/admin membership in the ANCHORING household', async () => {
      await service.decide({
        ...serverDecision,
        permissionSlug: 'update:calendar',
        scopeType: PluginGrantScope.Household,
        scopeId: 'hh_1',
        deciderId: 'user-hh-admin',
      });

      expect(authority.isHouseholdAdmin).toHaveBeenCalledWith('user-hh-admin', 'hh_1');
    });

    it('rejects a Household-scope decision from a non-admin member', async () => {
      authority.isHouseholdAdmin.mockResolvedValue(false);

      await expect(
        service.decide({
          ...serverDecision,
          permissionSlug: 'update:calendar',
          scopeType: PluginGrantScope.Household,
          scopeId: 'hh_1',
        }),
      ).rejects.toThrow(PluginGrantAuthorityError);
    });

    it('User-scope consent is decided by the user themself', async () => {
      await expect(
        service.decide({
          ...serverDecision,
          permissionSlug: 'read:public_content',
          scopeType: PluginGrantScope.User,
          scopeId: 'user-b',
          deciderId: 'user-a',
        }),
      ).rejects.toThrow(PluginGrantAuthorityError);
    });

    it('User-scope consent additionally requires a qualifying household with the plugin enabled', async () => {
      authority.hasQualifyingHouseholdForPlugin.mockResolvedValue(false);

      await expect(
        service.decide({
          ...serverDecision,
          permissionSlug: 'read:public_content',
          scopeType: PluginGrantScope.User,
          scopeId: 'user-a',
          deciderId: 'user-a',
        }),
      ).rejects.toThrow(PluginGrantAuthorityError);
      expect(authority.hasQualifyingHouseholdForPlugin).toHaveBeenCalledWith('user-a', 'plg_1');
    });
  });

  describe('decide — categorical exclusions', () => {
    it.each(['manage:plugin', 'manage:plugin:household'])(
      "hard-refuses the plugin-administration slug '%s' regardless of consent",
      async (slug) => {
        const admin = buildPluginManifest();
        admin.permissions.checks = [
          { slug, required: false, reason: { en: 'Attempts to administer the plugin subsystem itself.' } },
        ];
        db.plugin.findUnique.mockResolvedValue({ ...plugin, manifestJson: admin } as unknown as Plugin);

        await expect(service.decide({ ...serverDecision, permissionSlug: slug })).rejects.toThrow(
          PluginGrantExclusionError,
        );
        expect(db.permission.findUnique).not.toHaveBeenCalled();
      },
    );

    it("refuses a core permission whose subject is the 'all' wildcard", async () => {
      db.permission.findUnique.mockResolvedValue({
        slug: 'feedback:read',
        subject: 'all',
        riskLevel: RiskLevel.Critical,
      } as Permission);

      await expect(service.decide(serverDecision)).rejects.toThrow(PluginGrantExclusionError);
    });

    it.each(['manage:plugin', 'manage:plugin:household'])(
      "the administration exclusion applies to the BARE form of a DECLARED permission ('%s') — the plugin-origin route is not a bypass",
      async (bareSlug) => {
        const declared = buildPluginManifest({ permissions: { declares: [bareSlug], checks: [] } });
        declared.permissions.checks = [
          { slug: bareSlug, required: false, reason: { en: 'Declares an administration-shaped permission.' } },
        ];
        db.plugin.findUnique.mockResolvedValue({ ...plugin, manifestJson: declared } as unknown as Plugin);

        await expect(
          service.decide({ ...serverDecision, permissionSlug: `plugin|demo-sink|${bareSlug}` }),
        ).rejects.toThrow(PluginGrantExclusionError);
        expect(db.pluginPermission.findUnique).not.toHaveBeenCalled();
      },
    );

    it("refuses a declared permission claiming the 'all' subject — a naive CASL mapping would read wildcard authority", async () => {
      const declared = buildPluginManifest({ permissions: { declares: ['manage:all'], checks: [] } });
      declared.permissions.checks = [
        { slug: 'manage:all', required: false, reason: { en: 'Claims the universal subject for itself.' } },
      ];
      db.plugin.findUnique.mockResolvedValue({ ...plugin, manifestJson: declared } as unknown as Plugin);

      await expect(
        service.decide({ ...serverDecision, permissionSlug: 'plugin|demo-sink|manage:all' }),
      ).rejects.toThrow(PluginGrantExclusionError);
      expect(db.pluginPermission.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('decide — request validation', () => {
    it('rejects a decision for a plugin that does not exist', async () => {
      db.plugin.findUnique.mockResolvedValue(null);

      await expect(service.decide(serverDecision)).rejects.toThrow(PluginGrantPluginNotFoundError);
    });

    it('rejects a permission the manifest never requested', async () => {
      await expect(service.decide({ ...serverDecision, permissionSlug: 'read:game' })).rejects.toThrow(
        PluginGrantUnknownPermissionError,
      );
    });

    it('rejects a decision whose scope does not match the manifest consentScope', async () => {
      await expect(
        service.decide({
          ...serverDecision,
          permissionSlug: 'update:calendar', // household-consented
          scopeType: PluginGrantScope.User,
          scopeId: 'user-a',
          deciderId: 'user-a',
        }),
      ).rejects.toThrow(PluginGrantConsentScopeMismatchError);
    });

    it('rejects a Server-scope decision carrying a unit id', async () => {
      await expect(service.decide({ ...serverDecision, scopeId: 'hh_1' })).rejects.toThrow(PluginGrantScopeIdError);
    });

    it('rejects a unit-scope decision without a unit id', async () => {
      await expect(
        service.decide({
          ...serverDecision,
          permissionSlug: 'update:calendar',
          scopeType: PluginGrantScope.Household,
        }),
      ).rejects.toThrow(PluginGrantScopeIdError);
    });

    it('fails loudly when a declared permission has no PluginPermission catalog row', async () => {
      db.pluginPermission.findUnique.mockResolvedValue(null);

      await expect(
        service.decide({ ...serverDecision, permissionSlug: 'plugin|demo-sink|manage:digest' }),
      ).rejects.toThrow(PluginGrantUnknownPermissionError);
    });

    it('fails loudly when a core permission does not exist, hinting at a missing declare', async () => {
      db.permission.findUnique.mockResolvedValue(null);

      await expect(service.decide(serverDecision)).rejects.toThrow(/add it to permissions\.declares/);
    });

    it('a BGE upgrade past the manifest bgeCompat range does NOT block consent — decisions stay recordable', async () => {
      const outgrown = buildPluginManifest({ bgeCompat: '>=9.0.0' });
      db.plugin.findUnique.mockResolvedValue({ ...plugin, manifestJson: outgrown } as unknown as Plugin);

      const result = await service.decide(serverDecision);

      expect(result.changed).toBe(true);
    });

    it('wraps a genuinely invalid stored manifest in the grant-domain error, carrying the issues', async () => {
      const corrupted = buildPluginManifest({ version: 'one.two' });
      db.plugin.findUnique.mockResolvedValue({ ...plugin, manifestJson: corrupted } as unknown as Plugin);

      await expect(service.decide(serverDecision)).rejects.toThrow(PluginGrantManifestInvalidError);
    });

    it('refuses to decide when the stored manifest slug drifted from Plugin.slug — canonical slugs would cross namespaces', async () => {
      db.plugin.findUnique.mockResolvedValue({ ...plugin, slug: 'renamed-sink' } as unknown as Plugin);

      await expect(service.decide(serverDecision)).rejects.toThrow(PluginGrantManifestInvalidError);
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
    });

    it('refuses to decide when the stored manifest version drifted from Plugin.version — the row would be stamped with a version the checks did not come from', async () => {
      db.plugin.findUnique.mockResolvedValue({ ...plugin, version: '1.3.0' } as unknown as Plugin);

      await expect(service.decide(serverDecision)).rejects.toThrow(PluginGrantManifestInvalidError);
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
    });
  });

  describe('revokeForAuthorityLoss (#211 delete-to-pending)', () => {
    const revocable = [
      grantRow({
        id: 'grant_1',
        scopeType: PluginGrantScope.User,
        scopeId: 'user-a',
        permissionSlug: 'read:public_content',
      }),
      grantRow({
        id: 'grant_2',
        scopeType: PluginGrantScope.User,
        scopeId: 'user-a',
        permissionSlug: 'plugin|demo-sink|manage:digest',
      }),
    ];

    beforeEach(() => {
      db.pluginGrant.findMany.mockResolvedValue(revocable);
      db.pluginGrant.deleteMany.mockResolvedValue({ count: revocable.length });
    });

    it('deletes only GRANTED rows of the unit — durable denials are preserved — and emits one revocation event per row', async () => {
      const revoked = await service.revokeForAuthorityLoss({
        scopeType: PluginGrantScope.User,
        scopeId: 'user-a',
        reason: 'membership-removed',
      });

      expect(revoked).toHaveLength(2);
      expect(db.pluginGrant.findMany).toHaveBeenCalledWith({
        where: { scopeType: PluginGrantScope.User, scopeId: 'user-a', status: PluginGrantStatus.Granted },
      });
      expect(db.pluginGrant.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['grant_1', 'grant_2'] }, status: PluginGrantStatus.Granted },
      });
      expect(emitter.emit).toHaveBeenCalledTimes(2);
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginEvent.GrantRevoked,
        expect.objectContaining({
          reason: 'membership-removed',
          after: null,
          before: expect.objectContaining({ decidedRiskLevel: RiskLevel.Medium }),
        }),
      );
    });

    it('emits ONLY for rows actually deleted when a concurrent flip skipped one, and warns about the rest', async () => {
      // grant_2 flipped to Denied between the SELECT and the DELETE, so it
      // survives the status-guarded delete and must not be reported revoked.
      db.pluginGrant.deleteMany.mockResolvedValue({ count: 1 });
      db.pluginGrant.findMany
        .mockResolvedValueOnce(revocable)
        .mockResolvedValueOnce([{ id: 'grant_2' }] as PluginGrant[]);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const revoked = await service.revokeForAuthorityLoss({
        scopeType: PluginGrantScope.User,
        scopeId: 'user-a',
        reason: 'membership-removed',
      });

      expect(revoked.map((row) => row.id)).toEqual(['grant_1']);
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginEvent.GrantRevoked,
        expect.objectContaining({ before: expect.objectContaining({ id: 'grant_1' }) }),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('left 1 row(s) intact'));
      warn.mockRestore();
    });

    it('does not re-read when every row was deleted — the survivor lookup is the slow path only', async () => {
      await service.revokeForAuthorityLoss({
        scopeType: PluginGrantScope.User,
        scopeId: 'user-a',
        reason: 'membership-removed',
      });

      expect(db.pluginGrant.findMany).toHaveBeenCalledTimes(1);
    });

    it('narrows to one plugin when pluginId is supplied', async () => {
      await service.revokeForAuthorityLoss({
        scopeType: PluginGrantScope.Household,
        scopeId: 'hh_1',
        pluginId: 'plg_1',
        reason: 'household-deleted',
      });

      expect(db.pluginGrant.findMany).toHaveBeenCalledWith({
        where: {
          scopeType: PluginGrantScope.Household,
          scopeId: 'hh_1',
          status: PluginGrantStatus.Granted,
          pluginId: 'plg_1',
        },
      });
    });

    it('is a quiet no-op when the unit holds no grants', async () => {
      db.pluginGrant.findMany.mockResolvedValue([]);

      const revoked = await service.revokeForAuthorityLoss({
        scopeType: PluginGrantScope.User,
        scopeId: 'user-a',
        reason: 'user-deleted',
      });

      expect(revoked).toHaveLength(0);
      expect(db.pluginGrant.deleteMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('refuses Server-scope revocation with a scope-not-revocable error, not a scopeId error', async () => {
      await expect(
        service.revokeForAuthorityLoss({
          scopeType: PluginGrantScope.Server as unknown as Exclude<PluginGrantScope, typeof PluginGrantScope.Server>,
          scopeId: 'anything',
          reason: 'role-demoted',
        }),
      ).rejects.toThrow(PluginGrantScopeNotRevocableError);
    });

    it('refuses an empty scopeId — the sentinel never addresses a unit', async () => {
      await expect(
        service.revokeForAuthorityLoss({ scopeType: PluginGrantScope.User, scopeId: '', reason: 'user-deleted' }),
      ).rejects.toThrow(PluginGrantScopeIdError);
    });
  });
});
