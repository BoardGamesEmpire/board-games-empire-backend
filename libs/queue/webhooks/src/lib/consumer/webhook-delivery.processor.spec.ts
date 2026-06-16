import { Test } from '@nestjs/testing';
import { Job } from 'bullmq';
import { WEBHOOK_DELIVERY_ATTEMPTS } from '../constants/webhook-queue.constants';
import type { WebhookDeliveryJob } from '../interfaces/webhook-delivery-job.interface';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor';
import { WebhookDeliveryService } from './webhook-delivery.service';

describe('WebhookDeliveryProcessor', () => {
  let processor: WebhookDeliveryProcessor;
  let delivery: jest.Mocked<Pick<WebhookDeliveryService, 'deliver' | 'recordTerminalFailure'>>;

  const data: WebhookDeliveryJob = {
    deliveryId: 'del-1',
    subscriptionId: 'sub-1',
    eventType: 'event.event.created.v1',
    subjectId: 'event-1',
    actor: { kind: 'system', reason: 'test' },
    payload: {
      id: 'del-1',
      type: 'event.event.created.v1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      subjectId: 'event-1',
      data: { eventId: 'event-1' },
    },
  };

  // Only the three fields onFailed reads — Job has ~50, so build a typed slice.
  const makeJob = (over: { attempts?: number; attemptsMade?: number } = {}): Job<WebhookDeliveryJob> =>
    ({
      data,
      opts: { attempts: over.attempts ?? WEBHOOK_DELIVERY_ATTEMPTS },
      attemptsMade: over.attemptsMade ?? 0,
    }) as unknown as Job<WebhookDeliveryJob>;

  beforeEach(async () => {
    delivery = {
      deliver: jest.fn(),
      recordTerminalFailure: jest.fn(),
    } satisfies Partial<jest.Mocked<WebhookDeliveryService>>;

    const module = await Test.createTestingModule({
      providers: [WebhookDeliveryProcessor, { provide: WebhookDeliveryService, useValue: delivery }],
    }).compile();

    processor = module.get(WebhookDeliveryProcessor);
  });

  afterEach(() => jest.clearAllMocks());

  describe('process', () => {
    it('delegates the delivery to the service', async () => {
      await processor.process(makeJob());
      expect(delivery.deliver).toHaveBeenCalledWith(data);
    });
  });

  describe('onFailed', () => {
    it('does not record a terminal failure while retries remain', async () => {
      await processor.onFailed(makeJob({ attempts: 5, attemptsMade: 2 }), new Error('boom'));
      expect(delivery.recordTerminalFailure).not.toHaveBeenCalled();
    });

    it('does not record on the last retryable attempt (attemptsMade just below the cap)', async () => {
      await processor.onFailed(makeJob({ attempts: 5, attemptsMade: 4 }), new Error('boom'));
      expect(delivery.recordTerminalFailure).not.toHaveBeenCalled();
    });

    it('records a terminal failure once the attempt budget is exhausted', async () => {
      await processor.onFailed(makeJob({ attempts: 5, attemptsMade: 5 }), new Error('gateway down'));
      expect(delivery.recordTerminalFailure).toHaveBeenCalledTimes(1);
      expect(delivery.recordTerminalFailure).toHaveBeenCalledWith('sub-1', 'gateway down');
    });

    it('treats the first failure as terminal when no retries are configured', async () => {
      await processor.onFailed(makeJob({ attempts: 1, attemptsMade: 1 }), new Error('nope'));
      expect(delivery.recordTerminalFailure).toHaveBeenCalledWith('sub-1', 'nope');
    });

    it('treats a missing attempts option as a single attempt (terminal)', async () => {
      const job = { data, opts: {}, attemptsMade: 1 } as unknown as Job<WebhookDeliveryJob>;
      await processor.onFailed(job, new Error('x'));
      expect(delivery.recordTerminalFailure).toHaveBeenCalledWith('sub-1', 'x');
    });
  });
});
