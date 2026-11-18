import type { Redis } from '@bge/redis';
import { Logger } from '@nestjs/common';
import { GATEWAY_CONFIG_UPDATE_CHANNEL } from './constants/gateway-registry.constants';
import { GatewayConfigEventsService } from './gateway-config-events.service';
import type { GatewayConfigEvent } from './interfaces/gateway-config-event.interface';

type MessageHandler = (channel: string, message: string) => Promise<void> | void;

interface MockSubscriber {
  on: jest.Mock;
  quit: jest.Mock;
  subscribe: jest.Mock;
  unsubscribe: jest.Mock;
}

describe('GatewayConfigEventsService', () => {
  let errorSpy: jest.SpyInstance;
  let subscriber: MockSubscriber;
  let service: GatewayConfigEventsService;

  const validEvent: GatewayConfigEvent = {
    changeType: 'updated',
    configHash: 'hash-1',
    gatewayId: 'gateway-1',
    timestamp: 1_763_380_800_000,
  };

  const deliveredHandler = (): MessageHandler => {
    const call = subscriber.on.mock.calls.find(([eventName]) => eventName === 'message');
    if (!call) {
      throw new Error("no 'message' handler registered");
    }

    return call[1] as MessageHandler;
  };

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    subscriber = {
      on: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
      subscribe: jest.fn().mockResolvedValue(1),
      unsubscribe: jest.fn().mockResolvedValue(1),
    };
    const redis = {
      duplicate: jest.fn().mockReturnValue(subscriber),
      publish: jest.fn().mockResolvedValue(1),
    } as unknown as Redis;

    service = new GatewayConfigEventsService(redis);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('subscribe', () => {
    // A message on the channel is outside data until a schema says otherwise:
    // a wrong-typed field must not reach the registry's invalidation (#1322).
    it('drops a message that fails its schema, logging the channel, and still handles the next (#1322)', async () => {
      const handler = jest.fn<Promise<void>, [GatewayConfigEvent]>().mockResolvedValue(undefined);
      await service.subscribe(handler);

      await deliveredHandler()(GATEWAY_CONFIG_UPDATE_CHANNEL, JSON.stringify({ ...validEvent, timestamp: 'now' }));
      await deliveredHandler()(GATEWAY_CONFIG_UPDATE_CHANNEL, JSON.stringify(validEvent));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(validEvent);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(GATEWAY_CONFIG_UPDATE_CHANNEL));
    });

    // Invalid JSON takes the same path as a failed schema: one error line
    // naming the channel, and the listener keeps serving (#1322).
    it('drops a message that is not JSON (#1322)', async () => {
      const handler = jest.fn<Promise<void>, [GatewayConfigEvent]>().mockResolvedValue(undefined);
      await service.subscribe(handler);

      await deliveredHandler()(GATEWAY_CONFIG_UPDATE_CHANNEL, 'not-json{');
      await deliveredHandler()(GATEWAY_CONFIG_UPDATE_CHANNEL, JSON.stringify(validEvent));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(validEvent);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(GATEWAY_CONFIG_UPDATE_CHANNEL));
    });
  });
});
