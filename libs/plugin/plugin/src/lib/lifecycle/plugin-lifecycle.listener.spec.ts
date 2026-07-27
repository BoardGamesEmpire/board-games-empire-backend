import { AuditContextService, MutationEvent, type Actor } from '@bge/actor-context';
import {
  DatabaseService,
  Plugin,
  PluginGrantScope,
  PluginGrantStatus,
  PluginLifecycleEvent,
  PluginLifecycleEventType,
  ResourceType,
  RiskLevel,
} from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginConfigEventsService } from '../config/plugin-config-events.service';
import { PluginEvent } from '../events/constants';
import {
  HouseholdPluginConfigUpdatedEvent,
  HouseholdPluginUnitDisabledEvent,
  PluginConfigUpdatedEvent,
  PluginDisabledEvent,
  PluginGrantCreatedEvent,
  PluginGrantRevokedEvent,
  PluginInstalledEvent,
  PluginLoadFailedEvent,
  PluginUpdateCheckCompletedEvent,
  type PluginProvenance,
} from '../events/plugin.events';
import { PluginLifecycleListener, UNATTRIBUTED_LIFECYCLE_ACTOR } from './plugin-lifecycle.listener';

class UnrelatedMutationEvent extends MutationEvent<{ id: string }> {
  readonly subject = ResourceType.Plugin;
  readonly subjectId: string;

  constructor(after: { id: string }) {
    super(null, after, new Date());
    this.subjectId = after.id;
  }
}

describe('PluginLifecycleListener', () => {
  const initiatedAt = new Date('2026-07-24T00:00:00.000Z');
  const actor: Actor = { kind: 'user', userId: 'user-1' };

  let emitter: EventEmitter2;
  let db: MockDatabaseService;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getActor' | 'getCorrelationId'>>;
  let configEvents: jest.Mocked<Pick<PluginConfigEventsService, 'publish'>>;
  let listener: PluginLifecycleListener;

  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
  };

  const createdRow = (): Record<string, unknown> => {
    const call = db.pluginLifecycleEvent.create.mock.calls.at(-1);
    if (!call) {
      throw new Error('pluginLifecycleEvent.create was not called');
    }

    return (call[0] as { data: Record<string, unknown> }).data;
  };

  beforeEach(() => {
    emitter = new EventEmitter2();
    db = createMockDatabaseService();
    db.pluginLifecycleEvent.create.mockResolvedValue({} as PluginLifecycleEvent);
    auditContext = {
      getActor: jest.fn().mockReturnValue(actor),
      getCorrelationId: jest.fn().mockReturnValue('corr-1'),
    } as unknown as jest.Mocked<Pick<AuditContextService, 'getActor' | 'getCorrelationId'>>;
    configEvents = { publish: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<
      Pick<PluginConfigEventsService, 'publish'>
    >;

    listener = new PluginLifecycleListener(
      emitter,
      db as unknown as DatabaseService,
      auditContext as unknown as AuditContextService,
      configEvents as unknown as PluginConfigEventsService,
    );
    listener.onModuleInit();
  });

  afterEach(() => {
    listener.onModuleDestroy();
  });

  describe('registration and filtering', () => {
    it('ignores lifecycle routing keys carrying a non-MutationEvent payload', async () => {
      emitter.emit(PluginEvent.Enabled, { id: 'plugin-1', slug: 'demo-sink' });
      await flush();

      expect(db.pluginLifecycleEvent.create).not.toHaveBeenCalled();
    });

    it('ignores MutationEvents on non-lifecycle routing keys (plugin-emitted domain events)', async () => {
      emitter.emit('plugin.demo-sink.digest-sent', new UnrelatedMutationEvent({ id: 'x' }));
      await flush();

      expect(db.pluginLifecycleEvent.create).not.toHaveBeenCalled();
    });

    it('stops handling after onModuleDestroy', async () => {
      listener.onModuleDestroy();

      emitter.emit(
        PluginEvent.Disabled,
        new PluginDisabledEvent(
          { id: 'plugin-1', slug: 'demo-sink', enabled: true },
          { id: 'plugin-1', slug: 'demo-sink', enabled: false },
          initiatedAt,
        ),
      );
      await flush();

      expect(db.pluginLifecycleEvent.create).not.toHaveBeenCalled();
      listener.onModuleInit();
    });
  });

  describe('row shapes', () => {
    it('persists an Installed row with provenance, grants, and audit findings in the payload', async () => {
      const provenance: PluginProvenance = {
        installedFromUrl: 'https://registry.example/p.tgz',
        installedSha256: 'abc',
        registrySlug: 'bge-official',
      };
      const event = new PluginInstalledEvent(
        {
          id: 'plugin-1',
          slug: 'demo-sink',
          version: '1.2.3',
          category: 'FeedbackSink',
          scope: 'Server',
          enabled: false,
          bundled: false,
        },
        provenance,
        [{ slug: 'plugin.demo-sink.send', required: true, consentScope: 'server', reason: 'Send digests' }],
        null,
        initiatedAt,
      );

      emitter.emit(PluginEvent.Installed, event);
      await flush();

      expect(createdRow()).toEqual(
        expect.objectContaining({
          pluginId: 'plugin-1',
          pluginSlug: 'demo-sink',
          event: PluginLifecycleEventType.Installed,
          actorKind: 'user',
          actorUserId: 'user-1',
          correlationId: 'corr-1',
          manifestVersion: '1.2.3',
          scopeType: null,
          scopeId: null,
          occurredAt: event.occurredAt,
          payload: expect.objectContaining({
            provenance,
            auditFindings: null,
          }),
        }),
      );
    });

    it('persists a LoadFailed row carrying the error detail', async () => {
      const event = new PluginLoadFailedEvent(
        { id: 'plugin-1', slug: 'demo-sink', loadFailed: false, loadError: null },
        { id: 'plugin-1', slug: 'demo-sink', loadFailed: true, loadError: 'entrypoint missing' },
        initiatedAt,
      );

      emitter.emit(PluginEvent.LoadFailed, event);
      await flush();

      expect(createdRow()).toEqual(
        expect.objectContaining({
          event: PluginLifecycleEventType.LoadFailed,
          pluginSlug: 'demo-sink',
          payload: { loadError: 'entrypoint missing' },
        }),
      );
    });

    it('persists grant rows with scope coordinates, translating the Server empty-string sentinel to null', async () => {
      const event = new PluginGrantCreatedEvent(
        null,
        {
          id: 'grant-1',
          pluginId: 'plugin-1',
          scopeType: PluginGrantScope.Server,
          scopeId: '',
          permissionSlug: 'plugin.demo-sink.send',
          status: PluginGrantStatus.Granted,
          manifestVersion: '1.2.3',
          decidedRiskLevel: RiskLevel.Low,
        },
        initiatedAt,
      );
      db.plugin.findUnique.mockResolvedValue({ slug: 'demo-sink' } as Plugin);

      emitter.emit(PluginEvent.GrantCreated, event);
      await flush();

      expect(db.plugin.findUnique).toHaveBeenCalledWith({ where: { id: 'plugin-1' }, select: { slug: true } });
      expect(createdRow()).toEqual(
        expect.objectContaining({
          event: PluginLifecycleEventType.GrantCreated,
          pluginSlug: 'demo-sink',
          scopeType: PluginGrantScope.Server,
          scopeId: null,
          manifestVersion: '1.2.3',
          payload: {
            permissionSlug: 'plugin.demo-sink.send',
            status: PluginGrantStatus.Granted,
            decidedRiskLevel: RiskLevel.Low,
          },
        }),
      );
    });

    it('records the labeled placeholder slug when the plugin row is gone (uninstall race)', async () => {
      const event = new PluginGrantCreatedEvent(
        null,
        {
          id: 'grant-1',
          pluginId: 'plugin-gone',
          scopeType: PluginGrantScope.Household,
          scopeId: 'household-1',
          permissionSlug: 'plugin.x.y',
          status: PluginGrantStatus.Granted,
          manifestVersion: '1.0.0',
          decidedRiskLevel: RiskLevel.Low,
        },
        initiatedAt,
      );
      db.plugin.findUnique.mockResolvedValue(null);

      emitter.emit(PluginEvent.GrantCreated, event);
      await flush();

      expect(createdRow()).toEqual(
        expect.objectContaining({
          pluginSlug: 'unknown',
          scopeType: PluginGrantScope.Household,
          scopeId: 'household-1',
        }),
      );
    });

    it('persists a GrantRevoked row from the BEFORE snapshot with the reason — the deleted grant leaves only this record (#211)', async () => {
      const event = new PluginGrantRevokedEvent(
        {
          id: 'grant-1',
          pluginId: 'plugin-1',
          scopeType: PluginGrantScope.User,
          scopeId: 'user-1',
          permissionSlug: 'read:public_content',
          status: PluginGrantStatus.Granted,
          manifestVersion: '1.2.3',
          decidedRiskLevel: RiskLevel.Medium,
        },
        'membership-removed',
        initiatedAt,
      );
      db.plugin.findUnique.mockResolvedValue({ slug: 'demo-sink' } as Plugin);

      emitter.emit(PluginEvent.GrantRevoked, event);
      await flush();

      expect(createdRow()).toEqual(
        expect.objectContaining({
          event: PluginLifecycleEventType.GrantRevoked,
          scopeType: PluginGrantScope.User,
          scopeId: 'user-1',
          manifestVersion: '1.2.3',
          payload: {
            permissionSlug: 'read:public_content',
            decidedRiskLevel: RiskLevel.Medium,
            reason: 'membership-removed',
          },
        }),
      );
    });

    it('persists a UnitDisabled row with the escalated permission slug', async () => {
      const event = new HouseholdPluginUnitDisabledEvent(
        { id: 'hp-1', householdId: 'household-1', pluginId: 'plugin-1', enabled: true },
        { id: 'hp-1', householdId: 'household-1', pluginId: 'plugin-1', enabled: false },
        'plugin.demo-sink.escalated',
        initiatedAt,
      );
      db.plugin.findUnique.mockResolvedValue({ slug: 'demo-sink' } as Plugin);

      emitter.emit(PluginEvent.UnitDisabled, event);
      await flush();

      expect(createdRow()).toEqual(
        expect.objectContaining({
          event: PluginLifecycleEventType.UnitDisabled,
          scopeType: PluginGrantScope.Household,
          scopeId: 'household-1',
          payload: { requiredPermissionSlug: 'plugin.demo-sink.escalated' },
        }),
      );
    });

    it('persists an UpdateCheckCompleted row with the updateAvailable flag', async () => {
      const snapshot = {
        id: 'plugin-1',
        slug: 'demo-sink',
        lastUpdateCheckAt: new Date(),
        latestKnownVersion: '2.0.0',
        latestKnownChannel: 'stable',
        securityAdvisory: null,
      };
      const event = new PluginUpdateCheckCompletedEvent(snapshot, snapshot, true, initiatedAt);

      emitter.emit(PluginEvent.UpdateCheckCompleted, event);
      await flush();

      expect(createdRow()).toEqual(
        expect.objectContaining({
          event: PluginLifecycleEventType.UpdateCheckCompleted,
          payload: { updateAvailable: true },
        }),
      );
    });

    it('falls back to the unattributed system actor when no CLS scope is populated', async () => {
      auditContext.getActor.mockReturnValue(null);
      auditContext.getCorrelationId.mockReturnValue(null);

      emitter.emit(
        PluginEvent.Disabled,
        new PluginDisabledEvent(
          { id: 'plugin-1', slug: 'demo-sink', enabled: true },
          { id: 'plugin-1', slug: 'demo-sink', enabled: false },
          initiatedAt,
        ),
      );
      await flush();

      expect(createdRow()).toEqual(
        expect.objectContaining({
          actor: { kind: 'system', reason: UNATTRIBUTED_LIFECYCLE_ACTOR.reason },
          actorKind: 'system',
          actorUserId: null,
          correlationId: null,
        }),
      );
    });
  });

  describe('config reload publication', () => {
    it('publishes a reload for SERVER-scope config updates', async () => {
      const event = new PluginConfigUpdatedEvent(
        { id: 'plugin-1', slug: 'demo-sink', config: { a: 1 } },
        { id: 'plugin-1', slug: 'demo-sink', config: { a: 2 } },
        initiatedAt,
      );

      emitter.emit(PluginEvent.ConfigUpdated, event);
      await flush();

      expect(configEvents.publish).toHaveBeenCalledWith({ slug: 'demo-sink' });
    });

    it('publishes the reload even when the provenance write fails — functional state over the record', async () => {
      db.pluginLifecycleEvent.create.mockRejectedValue(new Error('db down'));
      const event = new PluginConfigUpdatedEvent(
        { id: 'plugin-1', slug: 'demo-sink', config: { a: 1 } },
        { id: 'plugin-1', slug: 'demo-sink', config: { a: 2 } },
        initiatedAt,
      );

      emitter.emit(PluginEvent.ConfigUpdated, event);
      await flush();

      expect(configEvents.publish).toHaveBeenCalledWith({ slug: 'demo-sink' });
    });

    it('does NOT publish for household-scope config updates sharing the routing key', async () => {
      const event = new HouseholdPluginConfigUpdatedEvent(
        { id: 'hp-1', householdId: 'household-1', pluginId: 'plugin-1', config: { a: 1 } },
        { id: 'hp-1', householdId: 'household-1', pluginId: 'plugin-1', config: { a: 2 } },
        initiatedAt,
      );
      db.plugin.findUnique.mockResolvedValue({ slug: 'demo-sink' } as Plugin);

      emitter.emit(PluginEvent.ConfigUpdated, event);
      await flush();

      expect(db.pluginLifecycleEvent.create).toHaveBeenCalledTimes(1);
      expect(configEvents.publish).not.toHaveBeenCalled();
    });
  });

  describe('failure isolation', () => {
    it('never throws into the emitter when persistence fails', async () => {
      db.pluginLifecycleEvent.create.mockRejectedValue(new Error('db down'));

      expect(() =>
        emitter.emit(
          PluginEvent.Disabled,
          new PluginDisabledEvent(
            { id: 'plugin-1', slug: 'demo-sink', enabled: true },
            { id: 'plugin-1', slug: 'demo-sink', enabled: false },
            initiatedAt,
          ),
        ),
      ).not.toThrow();
      await flush();
    });
  });
});
