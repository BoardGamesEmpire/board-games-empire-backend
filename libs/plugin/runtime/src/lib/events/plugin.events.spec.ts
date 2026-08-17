import { MutationEvent } from '@bge/actor-context';
import { PluginGrantScope, PluginGrantStatus, RiskLevel } from '@bge/database';
import { PluginEvent } from '@boardgamesempire/plugin-contract';
import type { StaticAnalysisFinding } from '../install/static-analysis.types';
import {
  GrantedPermissionRecord,
  HouseholdPluginConfigUpdatedEvent,
  HouseholdPluginUnitDisabledEvent,
  HouseholdPluginUnitEnabledEvent,
  NpmAuditFinding,
  PluginConfigUpdatedEvent,
  PluginDisabledEvent,
  PluginGrantCreatedEvent,
  PluginGrantRejectedEvent,
  PluginGrantRevokedEvent,
  PluginInstallAuditContext,
  PluginInstalledEvent,
  PluginProvenance,
  PluginUninstalledEvent,
  PluginUpdateCheckCompletedEvent,
  UserPluginUnitDisabledEvent,
  UserPluginUnitEnabledEvent,
} from './plugin.events';

const initiatedAt = new Date('2026-07-22T10:00:00.000Z');

const provenance: PluginProvenance = {
  installedFromUrl: 'https://plugins.example.com/demo-sink-1.2.0.tgz',
  installedSha256: 'a'.repeat(64),
  registrySlug: 'bge-official',
};

const grantedPermissions: readonly GrantedPermissionRecord[] = [
  {
    slug: 'plugin|demo-sink|manage:digest',
    required: true,
    consentScope: 'server',
    reason: 'Stores and manages the digest configuration.',
  },
];

const auditFindings: readonly NpmAuditFinding[] = [
  { module: 'left-pad', severity: 'high', advisoryUrl: 'https://github.com/advisories/GHSA-xxxx' },
];

const staticAnalysis: readonly StaticAnalysisFinding[] = [
  { file: 'index.js', kind: 'esm-import', specifier: 'node:fs', severity: 'warning', scanScope: 'default' },
];

describe('plugin lifecycle events', () => {
  describe('PluginInstalledEvent', () => {
    const event = new PluginInstalledEvent(
      {
        id: 'plg_1',
        slug: 'demo-sink',
        version: '1.2.0',
        category: 'FeedbackSink',
        scope: 'Server',
        enabled: false,
        bundled: false,
      },
      {
        provenance,
        grantedPermissions,
        auditFindings,
        staticAnalysis,
        acknowledgedForbiddenImports: ['axios'],
      },
      initiatedAt,
    );

    it('is a create-shaped MutationEvent on the Plugin subject', () => {
      expect(event).toBeInstanceOf(MutationEvent);
      expect(event.action).toBe('create');
      expect(event.subject).toBe('Plugin');
      expect(event.subjectId).toBe('plg_1');
      expect(PluginInstalledEvent.eventName).toBe(PluginEvent.Installed);
    });

    it('carries provenance, grants, and findings as context (off the snapshots)', () => {
      expect(event.provenance).toEqual(provenance);
      expect(event.grantedPermissions).toEqual(grantedPermissions);
      expect(event.auditFindings).toEqual(auditFindings);
      expect(event.staticAnalysis).toEqual(staticAnalysis);
      expect(event.after).not.toHaveProperty('provenance');
    });

    it('records the forbidden imports the installing admin accepted (#59)', () => {
      expect(event.acknowledgedForbiddenImports).toEqual(['axios']);
    });

    it('flattens the context object onto the event — consumers read fields, not a nested bag', () => {
      const context: PluginInstallAuditContext = {
        provenance,
        grantedPermissions,
        auditFindings: null,
        staticAnalysis: [],
        acknowledgedForbiddenImports: [],
      };
      const clean = new PluginInstalledEvent(
        {
          id: 'plg_2',
          slug: 'clean-sink',
          version: '2.0.0',
          category: 'FeedbackSink',
          scope: 'Server',
          enabled: false,
          bundled: true,
        },
        context,
        initiatedAt,
      );

      expect(clean).not.toHaveProperty('context');
      expect(clean.auditFindings).toBeNull();
      expect(clean.acknowledgedForbiddenImports).toEqual([]);
    });

    it('locks initiatedAt and stamps occurredAt at construction', () => {
      expect(event.initiatedAt).toBe(initiatedAt);
      expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(initiatedAt.getTime());
    });
  });

  describe('PluginUninstalledEvent', () => {
    it('is delete-shaped and takes its subjectId from the before snapshot', () => {
      const event = new PluginUninstalledEvent(
        { id: 'plg_1', slug: 'demo-sink', version: '1.2.0', bundled: false },
        [],
        initiatedAt,
      );

      expect(event.action).toBe('delete');
      expect(event.subjectId).toBe('plg_1');
      expect(PluginUninstalledEvent.eventName).toBe(PluginEvent.Uninstalled);
    });

    it('carries the affected-unit coordinates as context — the announcement seam, off the row snapshot', () => {
      const event = new PluginUninstalledEvent(
        { id: 'plg_1', slug: 'demo-sink', version: '1.2.0', bundled: false },
        [
          { scopeType: 'Household', householdId: 'hh_1' },
          { scopeType: 'User', userId: 'usr_1' },
        ],
        initiatedAt,
      );

      expect(event.affectedUnits).toEqual([
        { scopeType: 'Household', householdId: 'hh_1' },
        { scopeType: 'User', userId: 'usr_1' },
      ]);
      expect(event.before).not.toHaveProperty('affectedUnits');
    });
  });

  describe('enable/disable', () => {
    it('PluginDisabledEvent is update-shaped over the enablement snapshot', () => {
      const event = new PluginDisabledEvent(
        { id: 'plg_1', slug: 'demo-sink', enabled: true },
        { id: 'plg_1', slug: 'demo-sink', enabled: false },
        initiatedAt,
      );

      expect(event.action).toBe('update');
      expect(event.before.enabled).toBe(true);
      expect(event.after.enabled).toBe(false);
    });
  });

  describe('config updates share one routing key across two subjects', () => {
    it('server-scope and household-scope config events use PluginEvent.ConfigUpdated with distinct subjects', () => {
      const serverEvent = new PluginConfigUpdatedEvent(
        { id: 'plg_1', slug: 'demo-sink', config: { webhookUrl: 'https://old.example.com' } },
        { id: 'plg_1', slug: 'demo-sink', config: { webhookUrl: 'https://new.example.com' } },
        initiatedAt,
      );
      const householdEvent = new HouseholdPluginConfigUpdatedEvent(
        { id: 'hp_1', householdId: 'hh_1', pluginId: 'plg_1', config: {} },
        { id: 'hp_1', householdId: 'hh_1', pluginId: 'plg_1', config: { digestDay: 'monday' } },
        initiatedAt,
      );

      expect(PluginConfigUpdatedEvent.eventName).toBe(PluginEvent.ConfigUpdated);
      expect(HouseholdPluginConfigUpdatedEvent.eventName).toBe(PluginEvent.ConfigUpdated);
      expect(serverEvent.subject).toBe('Plugin');
      expect(householdEvent.subject).toBe('HouseholdPlugin');
      expect(householdEvent.subjectId).toBe('hp_1');
    });
  });

  describe('PluginUpdateCheckCompletedEvent', () => {
    it('carries updateAvailable as context over the persisted check columns', () => {
      const event = new PluginUpdateCheckCompletedEvent(
        {
          id: 'plg_1',
          slug: 'demo-sink',
          lastUpdateCheckAt: null,
          latestKnownVersion: null,
          latestKnownChannel: null,
          securityAdvisory: null,
        },
        {
          id: 'plg_1',
          slug: 'demo-sink',
          lastUpdateCheckAt: new Date('2026-07-22T11:00:00.000Z'),
          latestKnownVersion: '1.3.0',
          latestKnownChannel: 'stable',
          securityAdvisory: null,
        },
        true,
        initiatedAt,
      );

      expect(event.updateAvailable).toBe(true);
      expect(event.action).toBe('update');
      expect(event.after.latestKnownVersion).toBe('1.3.0');
    });
  });

  describe('grant decisions (#59 durable-denial model)', () => {
    const grantRow = {
      id: 'grant_1',
      pluginId: 'plg_1',
      scopeType: PluginGrantScope.Household,
      scopeId: 'hh_1',
      permissionSlug: 'plugin|demo-sink|update:calendar',
      status: PluginGrantStatus.Granted,
      manifestVersion: '1.2.0',
      decidedRiskLevel: RiskLevel.Low,
    };

    it('first decision is create-shaped', () => {
      const event = new PluginGrantCreatedEvent(null, grantRow, initiatedAt);

      expect(event.action).toBe('create');
      expect(event.subject).toBe('PluginGrant');
      expect(PluginGrantCreatedEvent.eventName).toBe(PluginEvent.GrantCreated);
    });

    it('a Denied → Granted flip is update-shaped on the same row', () => {
      const event = new PluginGrantCreatedEvent(
        { ...grantRow, status: PluginGrantStatus.Denied },
        grantRow,
        initiatedAt,
      );

      expect(event.action).toBe('update');
      expect(event.before?.status).toBe(PluginGrantStatus.Denied);
    });

    it('rejection events carry the Denied row as the after snapshot', () => {
      const denied = { ...grantRow, status: PluginGrantStatus.Denied };
      const event = new PluginGrantRejectedEvent(null, denied, initiatedAt);

      expect(event.after.status).toBe(PluginGrantStatus.Denied);
      expect(PluginGrantRejectedEvent.eventName).toBe(PluginEvent.GrantRejected);
    });

    it('revocation is delete-shaped and carries the authority-loss reason (#211)', () => {
      const event = new PluginGrantRevokedEvent(grantRow, 'membership-removed', initiatedAt);

      expect(event.action).toBe('delete');
      expect(event.after).toBeNull();
      expect(event.reason).toBe('membership-removed');
      expect(event.before.decidedRiskLevel).toBe(RiskLevel.Low);
      expect(PluginGrantRevokedEvent.eventName).toBe(PluginEvent.GrantRevoked);
    });
  });

  describe('HouseholdPluginUnitDisabledEvent', () => {
    it('carries the escalated permission slugs and manifest version as context; enabled is untouched', () => {
      const event = new HouseholdPluginUnitDisabledEvent(
        { id: 'hp_1', householdId: 'hh_1', pluginId: 'plg_1', enabled: true, suspendedForConsent: false },
        { id: 'hp_1', householdId: 'hh_1', pluginId: 'plg_1', enabled: true, suspendedForConsent: true },
        ['plugin|demo-sink|update:calendar', 'calendar:read'],
        '1.3.0',
        initiatedAt,
      );

      expect(event.requiredPermissionSlugs).toEqual(['plugin|demo-sink|update:calendar', 'calendar:read']);
      expect(event.manifestVersion).toBe('1.3.0');
      expect(event.after.enabled).toBe(true);
      expect(event.action).toBe('update');
      expect(HouseholdPluginUnitDisabledEvent.eventName).toBe(PluginEvent.UnitDisabled);
    });
  });

  describe('HouseholdPluginUnitEnabledEvent', () => {
    it('carries the clearing decision as context', () => {
      const event = new HouseholdPluginUnitEnabledEvent(
        { id: 'hp_1', householdId: 'hh_1', pluginId: 'plg_1', enabled: true, suspendedForConsent: true },
        { id: 'hp_1', householdId: 'hh_1', pluginId: 'plg_1', enabled: true, suspendedForConsent: false },
        'calendar:read',
        '1.3.0',
        initiatedAt,
      );

      expect(event.grantedPermissionSlug).toBe('calendar:read');
      expect(event.manifestVersion).toBe('1.3.0');
      expect(HouseholdPluginUnitEnabledEvent.eventName).toBe(PluginEvent.UnitEnabled);
    });
  });

  describe('UserPluginUnitDisabledEvent', () => {
    it('shares the UnitDisabled routing key with the household class and disambiguates on subject (#225)', () => {
      const event = new UserPluginUnitDisabledEvent(
        { id: 'up_1', userId: 'user_1', pluginId: 'plg_1', enabled: true, suspendedForConsent: false },
        { id: 'up_1', userId: 'user_1', pluginId: 'plg_1', enabled: true, suspendedForConsent: true },
        ['read:user_digest'],
        '1.3.0',
        initiatedAt,
      );

      expect(event.requiredPermissionSlugs).toEqual(['read:user_digest']);
      expect(event.manifestVersion).toBe('1.3.0');
      // The user's enabled intent survives the suspension, as it does at household scope.
      expect(event.after.enabled).toBe(true);
      expect(event.action).toBe('update');
      expect(event.subject).toBe('UserPlugin');
      expect(UserPluginUnitDisabledEvent.eventName).toBe(PluginEvent.UnitDisabled);
    });
  });

  describe('UserPluginUnitEnabledEvent', () => {
    it('carries the clearing decision as context (#225)', () => {
      const event = new UserPluginUnitEnabledEvent(
        { id: 'up_1', userId: 'user_1', pluginId: 'plg_1', enabled: true, suspendedForConsent: true },
        { id: 'up_1', userId: 'user_1', pluginId: 'plg_1', enabled: true, suspendedForConsent: false },
        'read:user_digest',
        '1.3.0',
        initiatedAt,
      );

      expect(event.grantedPermissionSlug).toBe('read:user_digest');
      expect(event.manifestVersion).toBe('1.3.0');
      expect(event.subject).toBe('UserPlugin');
      expect(UserPluginUnitEnabledEvent.eventName).toBe(PluginEvent.UnitEnabled);
    });
  });

  describe('base invariants', () => {
    it('rejects construction with both snapshots null (inherited MutationEvent guard)', () => {
      type Snapshot = Readonly<{ id: string; slug: string; enabled: boolean }>;

      expect(
        () => new PluginDisabledEvent(null as unknown as Snapshot, null as unknown as Snapshot, initiatedAt),
      ).toThrow(TypeError);
    });
  });
});
