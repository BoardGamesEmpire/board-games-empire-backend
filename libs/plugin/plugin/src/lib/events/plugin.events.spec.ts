import { MutationEvent } from '@bge/actor-context';
import { PluginGrantScope, PluginGrantStatus } from '@bge/database';
import { PluginEvent } from './constants.js';
import {
  GrantedPermissionRecord,
  HouseholdPluginConfigUpdatedEvent,
  HouseholdPluginUnitDisabledEvent,
  NpmAuditFinding,
  PluginConfigUpdatedEvent,
  PluginDisabledEvent,
  PluginGrantCreatedEvent,
  PluginGrantRejectedEvent,
  PluginInstalledEvent,
  PluginProvenance,
  PluginUninstalledEvent,
  PluginUpdateCheckCompletedEvent,
} from './plugin.events.js';

const initiatedAt = new Date('2026-07-22T10:00:00.000Z');

const provenance: PluginProvenance = {
  installedFromUrl: 'https://plugins.example.com/demo-sink-1.2.0.tgz',
  installedSha256: 'a'.repeat(64),
  registrySlug: 'bge-official',
};

const grantedPermissions: readonly GrantedPermissionRecord[] = [
  {
    slug: 'plugin:demo-sink:digest:manage',
    required: true,
    consentScope: 'server',
    reason: 'Stores and manages the digest configuration.',
  },
];

const auditFindings: readonly NpmAuditFinding[] = [
  { module: 'left-pad', severity: 'high', advisoryUrl: 'https://github.com/advisories/GHSA-xxxx' },
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
      provenance,
      grantedPermissions,
      auditFindings,
      initiatedAt,
    );

    it('is a create-shaped MutationEvent on the Plugin subject', () => {
      expect(event).toBeInstanceOf(MutationEvent);
      expect(event.action).toBe('create');
      expect(event.subject).toBe('Plugin');
      expect(event.subjectId).toBe('plg_1');
      expect(PluginInstalledEvent.eventName).toBe(PluginEvent.Installed);
    });

    it('carries provenance, grants, and audit findings as context (off the snapshots)', () => {
      expect(event.provenance).toEqual(provenance);
      expect(event.grantedPermissions).toEqual(grantedPermissions);
      expect(event.auditFindings).toEqual(auditFindings);
      expect(event.after).not.toHaveProperty('provenance');
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
        initiatedAt,
      );

      expect(event.action).toBe('delete');
      expect(event.subjectId).toBe('plg_1');
      expect(PluginUninstalledEvent.eventName).toBe(PluginEvent.Uninstalled);
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
      permissionSlug: 'plugin:demo-sink:calendar:write',
      status: PluginGrantStatus.Granted,
      manifestVersion: '1.2.0',
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
  });

  describe('HouseholdPluginUnitDisabledEvent', () => {
    it('carries the escalated permission slug as context', () => {
      const event = new HouseholdPluginUnitDisabledEvent(
        { id: 'hp_1', householdId: 'hh_1', pluginId: 'plg_1', enabled: true },
        { id: 'hp_1', householdId: 'hh_1', pluginId: 'plg_1', enabled: false },
        'plugin:demo-sink:calendar:write',
        initiatedAt,
      );

      expect(event.requiredPermissionSlug).toBe('plugin:demo-sink:calendar:write');
      expect(event.action).toBe('update');
      expect(HouseholdPluginUnitDisabledEvent.eventName).toBe(PluginEvent.UnitDisabled);
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
