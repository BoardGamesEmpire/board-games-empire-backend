import { DatabaseService, Plugin, PluginCategory, PluginScope } from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { Logger } from '@nestjs/common';
import { PluginConfigEventsService, type PluginConfigReloadHandler } from './plugin-config-events.service';
import { PluginConfigService } from './plugin-config.service';

const makePluginRow = (overrides: Partial<Plugin> = {}): Plugin =>
  ({
    id: 'plugin-1',
    slug: 'demo-sink',
    version: '1.0.0',
    category: PluginCategory.FeedbackSink,
    scope: PluginScope.Server,
    enabled: true,
    bundled: false,
    manifestJson: {},
    config: {},
    loadFailed: false,
    loadError: null,
    ...overrides,
  }) as Plugin;

describe('PluginConfigService', () => {
  let db: MockDatabaseService;
  let events: jest.Mocked<Pick<PluginConfigEventsService, 'subscribe' | 'publish'>>;
  let service: PluginConfigService;

  beforeEach(() => {
    db = createMockDatabaseService();
    events = {
      subscribe: jest.fn().mockResolvedValue(async () => undefined),
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Pick<PluginConfigEventsService, 'subscribe' | 'publish'>>;

    service = new PluginConfigService(db as unknown as DatabaseService, events as unknown as PluginConfigEventsService);
  });

  describe('prime / snapshotFor', () => {
    it('serves the primed snapshot', () => {
      service.prime('demo-sink', { apiKey: 'k', batchSize: 10 });

      expect(service.snapshotFor('demo-sink')).toEqual({ apiKey: 'k', batchSize: 10 });
    });

    it('returns a frozen snapshot — downstream mutation throws in strict mode', () => {
      service.prime('demo-sink', { apiKey: 'k' });
      const snapshot = service.snapshotFor('demo-sink');

      expect(Object.isFrozen(snapshot)).toBe(true);
    });

    it('serves the frozen empty config for an unknown slug', () => {
      const snapshot = service.snapshotFor('never-primed');

      expect(snapshot).toEqual({});
      expect(Object.isFrozen(snapshot)).toBe(true);
    });

    it('normalizes a non-object config to the empty snapshot rather than serving a scalar', () => {
      service.prime('demo-sink', 'oops');

      expect(service.snapshotFor('demo-sink')).toEqual({});
    });

    it('normalizes an array config to the empty snapshot and reports it as an array, not an object', () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      try {
        service.prime('demo-sink', ['a', 'b']);

        expect(service.snapshotFor('demo-sink')).toEqual({});
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('(got array)'));
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('normalizes a null config and reports it as null', () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      try {
        service.prime('demo-sink', null);

        expect(service.snapshotFor('demo-sink')).toEqual({});
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('(got null)'));
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe('evict', () => {
    it('drops the snapshot and removes the slug from the interval backstop', async () => {
      service.prime('demo-sink', { apiKey: 'k' });

      service.evict('demo-sink');

      expect(service.snapshotFor('demo-sink')).toEqual({});
      await service.refreshOnInterval();
      expect(db.plugin.findUnique).not.toHaveBeenCalled();
    });

    it('is a no-op for an unknown slug', () => {
      expect(() => service.evict('never-primed')).not.toThrow();
    });
  });

  describe('refresh', () => {
    it('swaps the snapshot from the DB row', async () => {
      service.prime('demo-sink', { apiKey: 'old' });
      db.plugin.findUnique.mockResolvedValue(makePluginRow({ config: { apiKey: 'new' } }));

      await service.refresh('demo-sink');

      expect(db.plugin.findUnique).toHaveBeenCalledWith({ where: { slug: 'demo-sink' }, select: { config: true } });
      expect(service.snapshotFor('demo-sink')).toEqual({ apiKey: 'new' });
    });

    it('drops the snapshot when the plugin row no longer exists', async () => {
      service.prime('demo-sink', { apiKey: 'old' });
      db.plugin.findUnique.mockResolvedValue(null);

      await service.refresh('demo-sink');

      expect(service.snapshotFor('demo-sink')).toEqual({});
    });

    it('retains the prior snapshot when the DB read fails', async () => {
      service.prime('demo-sink', { apiKey: 'old' });
      db.plugin.findUnique.mockRejectedValue(new Error('db down'));

      await service.refresh('demo-sink');

      expect(service.snapshotFor('demo-sink')).toEqual({ apiKey: 'old' });
    });
  });

  describe('onModuleInit subscription', () => {
    it('subscribes and refreshes the slug named in each reload event', async () => {
      await service.onModuleInit();

      expect(events.subscribe).toHaveBeenCalledTimes(1);

      service.prime('demo-sink', { apiKey: 'old' });
      db.plugin.findUnique.mockResolvedValue(makePluginRow({ config: { apiKey: 'reloaded' } }));

      const handler = events.subscribe.mock.calls[0]?.[0] as PluginConfigReloadHandler;
      await handler({ slug: 'demo-sink' });

      expect(service.snapshotFor('demo-sink')).toEqual({ apiKey: 'reloaded' });
    });
  });

  describe('refreshOnInterval', () => {
    it('re-reads every known slug', async () => {
      service.prime('plugin-a', {});
      service.prime('plugin-b', {});
      db.plugin.findUnique.mockResolvedValue(makePluginRow({ config: { fresh: true } }));

      await service.refreshOnInterval();

      expect(db.plugin.findUnique).toHaveBeenCalledTimes(2);
      expect(service.snapshotFor('plugin-a')).toEqual({ fresh: true });
      expect(service.snapshotFor('plugin-b')).toEqual({ fresh: true });
    });

    it('does nothing when no slug is known', async () => {
      await service.refreshOnInterval();

      expect(db.plugin.findUnique).not.toHaveBeenCalled();
    });
  });
});
