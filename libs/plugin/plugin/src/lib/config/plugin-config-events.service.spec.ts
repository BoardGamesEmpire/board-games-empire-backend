import type { Redis } from '@bge/redis';
import { PluginConfigEventsService, type PluginConfigReloadEvent } from './plugin-config-events.service';
import { PLUGIN_CONFIG_UPDATE_CHANNEL } from './plugin-config.constants';

type MessageHandler = (channel: string, message: string) => void;

interface MockSubscriber {
  subscribe: jest.Mock;
  unsubscribe: jest.Mock;
  quit: jest.Mock;
  on: jest.Mock;
}

describe('PluginConfigEventsService', () => {
  let publishMock: jest.Mock;
  let subscriber: MockSubscriber;
  let redis: Redis;
  let service: PluginConfigEventsService;

  const deliveredHandler = (): MessageHandler => {
    const call = subscriber.on.mock.calls.find(([eventName]) => eventName === 'message');
    if (!call) {
      throw new Error("no 'message' handler registered");
    }

    return call[1] as MessageHandler;
  };

  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
  };

  beforeEach(() => {
    publishMock = jest.fn().mockResolvedValue(1);
    subscriber = {
      subscribe: jest.fn().mockResolvedValue(1),
      unsubscribe: jest.fn().mockResolvedValue(1),
      quit: jest.fn().mockResolvedValue('OK'),
      on: jest.fn(),
    };
    redis = {
      publish: publishMock,
      duplicate: jest.fn().mockReturnValue(subscriber),
    } as unknown as Redis;

    service = new PluginConfigEventsService(redis);
  });

  describe('publish', () => {
    it('publishes the reload event as JSON on the config channel', async () => {
      await service.publish({ slug: 'demo-sink' });

      expect(publishMock).toHaveBeenCalledWith(PLUGIN_CONFIG_UPDATE_CHANNEL, JSON.stringify({ slug: 'demo-sink' }));
    });

    it('logs but does not throw when publish fails — the DB row remains the source of truth', async () => {
      publishMock.mockRejectedValue(new Error('redis down'));

      await expect(service.publish({ slug: 'demo-sink' })).resolves.toBeUndefined();
    });
  });

  describe('subscribe', () => {
    it('subscribes a duplicated connection to the config channel', async () => {
      await service.subscribe(jest.fn());

      expect(redis.duplicate).toHaveBeenCalledTimes(1);
      expect(subscriber.subscribe).toHaveBeenCalledWith(PLUGIN_CONFIG_UPDATE_CHANNEL);
    });

    it('invokes the handler with the parsed event', async () => {
      const handler = jest.fn<Promise<void>, [PluginConfigReloadEvent]>().mockResolvedValue(undefined);
      await service.subscribe(handler);

      deliveredHandler()(PLUGIN_CONFIG_UPDATE_CHANNEL, JSON.stringify({ slug: 'demo-sink' }));
      await flush();

      expect(handler).toHaveBeenCalledWith({ slug: 'demo-sink' });
    });

    it('ignores messages from other channels', async () => {
      const handler = jest.fn();
      await service.subscribe(handler);

      deliveredHandler()('some.other.channel', JSON.stringify({ slug: 'demo-sink' }));
      await flush();

      expect(handler).not.toHaveBeenCalled();
    });

    it('drops malformed JSON without invoking the handler or crashing', async () => {
      const handler = jest.fn();
      await service.subscribe(handler);

      deliveredHandler()(PLUGIN_CONFIG_UPDATE_CHANNEL, 'not-json{');
      await flush();

      expect(handler).not.toHaveBeenCalled();
    });

    it('drops structurally invalid events (missing slug)', async () => {
      const handler = jest.fn();
      await service.subscribe(handler);

      deliveredHandler()(PLUGIN_CONFIG_UPDATE_CHANNEL, JSON.stringify({}));
      await flush();

      expect(handler).not.toHaveBeenCalled();
    });

    it('survives a throwing handler', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('handler boom'));
      await service.subscribe(handler);

      deliveredHandler()(PLUGIN_CONFIG_UPDATE_CHANNEL, JSON.stringify({ slug: 'demo-sink' }));
      await flush();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('rejects a second subscription on the same instance', async () => {
      await service.subscribe(jest.fn());

      await expect(service.subscribe(jest.fn())).rejects.toThrow(/already has an active subscription/);
    });

    it('returns an unsubscribe function that tears the connection down', async () => {
      const unsubscribe = await service.subscribe(jest.fn());

      await unsubscribe();

      expect(subscriber.unsubscribe).toHaveBeenCalledWith(PLUGIN_CONFIG_UPDATE_CHANNEL);
      expect(subscriber.quit).toHaveBeenCalledTimes(1);
    });
  });

  describe('onModuleDestroy', () => {
    it('is a no-op without an active subscription', async () => {
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });

    it('cleans up the subscriber connection and tolerates cleanup errors', async () => {
      subscriber.quit.mockRejectedValue(new Error('already closed'));
      await service.subscribe(jest.fn());

      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
      expect(subscriber.unsubscribe).toHaveBeenCalled();
    });

    it('still quits the connection when unsubscribe rejects — no leaked subscriber', async () => {
      subscriber.unsubscribe.mockRejectedValue(new Error('redis gone'));
      await service.subscribe(jest.fn());

      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
      expect(subscriber.quit).toHaveBeenCalledTimes(1);
    });
  });
});
