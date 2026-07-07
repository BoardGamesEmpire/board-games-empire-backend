import { WebhookSubscription, WebhookSubscriptionStatus } from '@bge/database';
import { SecureHttpService } from '@bge/secure-http';
import { EncryptionService } from '@bge/services';
import { createTestingModuleWithDb, MockDatabaseService } from '@bge/testing';
import { WEBHOOK_DISABLED_EVENT, WebhookSigner } from '@bge/webhooks';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Http } from '@status/codes';
import { createHmac } from 'node:crypto';
import { WEBHOOK_DELIVERY_HEADERS } from '../constants/webhook-queue.constants';
import type { WebhookDeliveryJob } from '../interfaces/webhook-delivery-job.interface';
import { WebhookDeliveryFailedError, WebhookDeliveryService } from './webhook-delivery.service';

const PLAINTEXT_SECRET = 'whsec_test_secret_value_1234567890';
const STORED_SECRET = `enc(${PLAINTEXT_SECRET})`; // what the column holds (ciphertext)

function httpResponse(status: number) {
  return { status, headers: {}, body: null, raw: '', durationMs: 1, finalUrl: 'https://x', redirectCount: 0 };
}

function job(overrides: Partial<WebhookDeliveryJob> = {}): WebhookDeliveryJob {
  return {
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
    ...overrides,
  };
}

describe('WebhookDeliveryService', () => {
  let service: WebhookDeliveryService;
  let db: MockDatabaseService;
  let http: jest.Mocked<Pick<SecureHttpService, 'request'>>;
  let emitter: jest.Mocked<Pick<EventEmitter2, 'emit'>>;
  let encryption: jest.Mocked<Pick<EncryptionService, 'decrypt'>>;

  beforeEach(async () => {
    http = { request: jest.fn() };
    emitter = { emit: jest.fn() };
    encryption = { decrypt: jest.fn((cipher: string) => cipher.replace(/^enc\(|\)$/g, '')) };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [
        WebhookDeliveryService,
        WebhookSigner,
        { provide: SecureHttpService, useValue: http },
        { provide: EncryptionService, useValue: encryption },
        { provide: EventEmitter2, useValue: emitter },
      ],
    });

    service = module.get(WebhookDeliveryService);
    db = mockDb;
  });

  afterEach(() => jest.clearAllMocks());

  describe('deliver', () => {
    beforeEach(() => {
      db.webhookSubscription.findFirst.mockResolvedValue({
        id: 'sub-1',
        url: 'https://hooks.example.com/bge',
        secret: STORED_SECRET,
        status: WebhookSubscriptionStatus.Active,
      } as WebhookSubscription);
      db.webhookSubscription.update.mockResolvedValue({ id: 'sub-1' } as WebhookSubscription);
    });

    it('decrypts the stored secret and signs the exact bytes on the wire with the plaintext', async () => {
      http.request.mockResolvedValue(httpResponse(Http.Ok));

      await service.deliver(job());

      expect(encryption.decrypt).toHaveBeenCalledWith(STORED_SECRET);

      const [url, options] = http.request.mock.calls[0];
      expect(url).toBe('https://hooks.example.com/bge');
      expect(options?.method).toBe('POST');

      const sentBody = options?.body as string;
      const timestamp = Number(options?.headers?.[WEBHOOK_DELIVERY_HEADERS.timestamp]);
      // Signature must verify against the DECRYPTED secret, not the stored ciphertext.
      const expectedSig = createHmac('sha256', PLAINTEXT_SECRET).update(`${timestamp}.${sentBody}`).digest('hex');

      expect(options?.headers?.[WEBHOOK_DELIVERY_HEADERS.signature]).toBe(expectedSig);
      expect(options?.headers?.[WEBHOOK_DELIVERY_HEADERS.event]).toBe('event.event.created.v1');
      expect(options?.headers?.[WEBHOOK_DELIVERY_HEADERS.deliveryId]).toBe('del-1');
    });

    it('resets failure tracking on a 2xx', async () => {
      http.request.mockResolvedValue(httpResponse(Http.Accepted));

      await service.deliver(job());

      expect(db.webhookSubscription.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'sub-1',
            deletedAt: null,
          },
          data: expect.objectContaining({ consecutiveFailures: 0, lastDeliveryAt: expect.any(Date) }),
        }),
      );
    });

    it('throws on a non-2xx so BullMQ counts the attempt', async () => {
      http.request.mockResolvedValue(httpResponse(Http.InternalServerError));
      await expect(service.deliver(job())).rejects.toThrow(WebhookDeliveryFailedError);
      expect(db.webhookSubscription.update).not.toHaveBeenCalled();
    });

    it('drops silently when the subscription is no longer active', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue({
        id: 'sub-1',
        url: 'https://x',
        secret: STORED_SECRET,
        status: WebhookSubscriptionStatus.Disabled,
      } as WebhookSubscription);

      await service.deliver(job());

      expect(http.request).not.toHaveBeenCalled();
      expect(encryption.decrypt).not.toHaveBeenCalled();
    });
  });

  describe('recordTerminalFailure', () => {
    it('increments the counter without disabling below the threshold', async () => {
      db.webhookSubscription.update.mockResolvedValue({
        consecutiveFailures: 2,
        createdById: 'owner-1',
      } as WebhookSubscription);

      await service.recordTerminalFailure('sub-1', new Error('boom'));

      expect(db.webhookSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { consecutiveFailures: { increment: 1 } } }),
      );
      expect(db.webhookSubscription.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('auto-disables via a race-safe Active -> Failed update and emits once', async () => {
      db.webhookSubscription.update.mockResolvedValue({
        consecutiveFailures: 3,
        createdById: 'owner-1',
      } as WebhookSubscription);
      db.webhookSubscription.updateMany.mockResolvedValue({ count: 1 });

      await service.recordTerminalFailure('sub-1', new Error('boom'));

      expect(db.webhookSubscription.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sub-1', status: WebhookSubscriptionStatus.Active },
          data: expect.objectContaining({ status: WebhookSubscriptionStatus.Failed, disabledAt: expect.any(Date) }),
        }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        WEBHOOK_DISABLED_EVENT,
        expect.objectContaining({ subscriptionId: 'sub-1', createdById: 'owner-1', status: 'Failed' }),
      );
    });

    it('stays silent when it loses the disable race (count === 0)', async () => {
      db.webhookSubscription.update.mockResolvedValue({
        consecutiveFailures: 4,
        createdById: 'owner-1',
      } as WebhookSubscription);
      db.webhookSubscription.updateMany.mockResolvedValue({ count: 0 });

      await service.recordTerminalFailure('sub-1', new Error('boom'));

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('emits a sanitized code + message on the disabled event — never the raw error', async () => {
      db.webhookSubscription.update.mockResolvedValue({
        consecutiveFailures: 3,
        createdById: 'owner-1',
      } as WebhookSubscription);
      db.webhookSubscription.updateMany.mockResolvedValue({ count: 1 });

      await service.recordTerminalFailure(
        'sub-1',
        new Error('connect ECONNREFUSED 10.0.4.12:443 (internal service, not the subscriber URL)'),
      );

      expect(emitter.emit).toHaveBeenCalledWith(
        WEBHOOK_DISABLED_EVENT,
        expect.objectContaining({
          lastErrorCode: 'UNKNOWN',
          lastError: 'Webhook delivery failed due to an internal error.',
        }),
      );
    });
  });
});
