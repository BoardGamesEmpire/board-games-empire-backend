import { Action, Prisma, ResourceType, WebhookSubscriptionEventType, WebhookSubscriptionStatus } from '@bge/database';
import type { AppAbility } from '@bge/permissions';
import { EncryptionService } from '@bge/services';
import { createTestingModuleWithDb, MockDatabaseService } from '@bge/testing';
import {
  CreateWebhookSubscriptionDto,
  WebhookEventRegistry,
  WebhookEventType,
  WebhookVisibilityService,
} from '@bge/webhooks';
import { createPrismaAbility } from '@casl/prisma';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WEBHOOK_SECRET_REDACTED, WebhookSubscriptionService } from './webhook-subscription.service';

type WebhookWithEvents = Prisma.WebhookSubscriptionGetPayload<{ include: { eventTypes: true } }>;

function makeEventType(overrides: Partial<WebhookSubscriptionEventType> = {}): WebhookSubscriptionEventType {
  return {
    id: 'et-1',
    subscriptionId: 'sub-1',
    eventType: 'event.event.created.v1',
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function makeWebhookSub(overrides: Partial<WebhookWithEvents> = {}): WebhookWithEvents {
  return {
    id: 'sub-1',
    url: 'https://hooks.example.com/bge',
    resourceType: ResourceType.Event,
    resourceId: null,
    householdId: null,
    secret: 'enc(whsec_default)',
    status: WebhookSubscriptionStatus.Active,
    consecutiveFailures: 0,
    lastDeliveryAt: null,
    disabledAt: null,
    deletedAt: null,
    createdById: 'user-1',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    eventTypes: [],
    ...overrides,
  };
}

describe('WebhookSubscriptionService', () => {
  let service: WebhookSubscriptionService;
  let db: MockDatabaseService;
  let visibility: jest.Mocked<Pick<WebhookVisibilityService, 'isVisibleTo'>>;
  let encryption: jest.Mocked<Pick<EncryptionService, 'encrypt' | 'decrypt'>>;

  const allowAll = createPrismaAbility([{ action: Action.manage, subject: 'all' }]) as AppAbility;
  const denyAll = createPrismaAbility([]) as AppAbility;

  beforeEach(async () => {
    visibility = { isVisibleTo: jest.fn().mockResolvedValue(true) };
    // Deterministic, reversible stand-in so we can assert "ciphertext stored,
    // plaintext revealed" without real crypto.
    encryption = {
      encrypt: jest.fn((plain: string) => `enc(${plain})`),
      decrypt: jest.fn((cipher: string) => cipher.replace(/^enc\(|\)$/g, '')),
    };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [
        WebhookSubscriptionService,
        WebhookEventRegistry,
        { provide: WebhookVisibilityService, useValue: visibility },
        { provide: EncryptionService, useValue: encryption },
      ],
    });

    service = module.get(WebhookSubscriptionService);
    db = mockDb;
  });

  afterEach(() => jest.clearAllMocks());

  const baseDto = (overrides: Partial<CreateWebhookSubscriptionDto> = {}): CreateWebhookSubscriptionDto => ({
    url: 'https://hooks.example.com/bge',
    resourceType: ResourceType.Event,
    eventTypes: [WebhookEventType.EventCreated, WebhookEventType.EventUpdated],
    ...overrides,
  });

  describe('create', () => {
    it('stores the secret encrypted and reveals the generated plaintext exactly once', async () => {
      db.webhookSubscription.create.mockResolvedValue(makeWebhookSub());

      const result = await service.create('user-1', baseDto(), [allowAll]);

      // Stored ciphertext is the encrypted form of a freshly generated whsec_ secret.
      expect(encryption.encrypt).toHaveBeenCalledWith(expect.stringMatching(/^whsec_/));
      expect(db.webhookSubscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            url: 'https://hooks.example.com/bge',
            status: WebhookSubscriptionStatus.Active,
            secret: expect.stringMatching(/^enc\(whsec_/),
            createdBy: { connect: { id: 'user-1' } },
            eventTypes: {
              create: [{ eventType: WebhookEventType.EventCreated }, { eventType: WebhookEventType.EventUpdated }],
            },
          }),
        }),
      );

      // Returned secret is the plaintext, never the stored ciphertext.
      expect(result.secret).toMatch(/^whsec_/);
      expect(result.secret).not.toContain('enc(');
    });

    it('encrypts and reveals a caller-supplied secret', async () => {
      db.webhookSubscription.create.mockResolvedValue(makeWebhookSub());

      const result = await service.create('user-1', baseDto({ secret: 'whsec_caller_supplied_secret_value' }), [
        allowAll,
      ]);

      expect(encryption.encrypt).toHaveBeenCalledWith('whsec_caller_supplied_secret_value');
      expect(db.webhookSubscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ secret: 'enc(whsec_caller_supplied_secret_value)' }),
        }),
      );
      expect(result.secret).toBe('whsec_caller_supplied_secret_value');
    });

    it('rejects when the caller cannot read the subject (CASL-at-create)', async () => {
      await expect(service.create('user-1', baseDto(), [denyAll])).rejects.toThrow(ForbiddenException);
      expect(db.webhookSubscription.create).not.toHaveBeenCalled();
      expect(encryption.encrypt).not.toHaveBeenCalled();
    });

    it('rejects when no abilities are present', async () => {
      await expect(service.create('user-1', baseDto(), [])).rejects.toThrow(ForbiddenException);
    });

    it('requires every ability in the intersection to permit the subject', async () => {
      await expect(service.create('user-1', baseDto(), [allowAll, denyAll])).rejects.toThrow(ForbiddenException);
    });

    it('rejects an event type that does not belong to the declared resource', async () => {
      const dto = baseDto({ resourceType: ResourceType.Game, eventTypes: [WebhookEventType.EventCreated] });
      await expect(service.create('user-1', dto, [allowAll])).rejects.toThrow(BadRequestException);
    });

    it('checks instance visibility when resourceId is scoped', async () => {
      db.webhookSubscription.create.mockResolvedValue(makeWebhookSub());
      await service.create('user-1', baseDto({ resourceId: 'event-9' }), [allowAll]);
      expect(visibility.isVisibleTo).toHaveBeenCalledWith(ResourceType.Event, 'event-9', allowAll);
    });

    it('rejects when the scoped instance is not visible', async () => {
      visibility.isVisibleTo.mockResolvedValue(false);
      await expect(service.create('user-1', baseDto({ resourceId: 'event-9' }), [allowAll])).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('checks household readability when householdId is scoped', async () => {
      db.household.count.mockResolvedValue(0);
      await expect(service.create('user-1', baseDto({ householdId: 'hh-1' }), [allowAll])).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('reads redact the secret', () => {
    it('getById never returns the stored ciphertext', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(makeWebhookSub({ secret: 'enc(whsec_x)' }));
      const result = await service.getById('sub-1', 'user-1');
      expect(result.secret).toBe(WEBHOOK_SECRET_REDACTED);
    });

    it('list redacts every row', async () => {
      db.webhookSubscription.findMany.mockResolvedValue([
        makeWebhookSub({ id: 'sub-1', secret: 'enc(whsec_a)' }),
        makeWebhookSub({ id: 'sub-2', secret: 'enc(whsec_b)' }),
      ]);
      const result = await service.list('user-1');
      expect(result.map((s) => s.secret)).toEqual([WEBHOOK_SECRET_REDACTED, WEBHOOK_SECRET_REDACTED]);
    });
  });

  describe('getById', () => {
    it('scopes by owner and throws NotFound when absent', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(null);
      await expect(service.getById('sub-x', 'user-1')).rejects.toThrow(NotFoundException);
      expect(db.webhookSubscription.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sub-x', createdById: 'user-1', deletedAt: null } }),
      );
    });
  });

  describe('update', () => {
    it('re-encrypts and reveals a rotated secret', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(makeWebhookSub());
      db.webhookSubscription.update.mockResolvedValue(makeWebhookSub());

      const result = await service.update('sub-1', 'user-1', { secret: 'whsec_rotated_value_1234567890' }, [allowAll]);

      expect(encryption.encrypt).toHaveBeenCalledWith('whsec_rotated_value_1234567890');
      expect(db.webhookSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ secret: 'enc(whsec_rotated_value_1234567890)' }) }),
      );
      expect(result.secret).toBe('whsec_rotated_value_1234567890');
    });

    it('redacts when the update does not rotate the secret', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(makeWebhookSub());

      db.webhookSubscription.update.mockResolvedValue(makeWebhookSub());

      const result = await service.update('sub-1', 'user-1', { url: 'https://new.example.com/hook' }, [allowAll]);

      expect(db.webhookSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ secret: undefined }) }),
      );
      expect(result.secret).toBe(WEBHOOK_SECRET_REDACTED);
    });

    it('throws when the DTO is empty', async () => {
      await expect(service.update('sub-1', 'user-1', {}, [allowAll])).rejects.toThrow(BadRequestException);
    });

    it('refuses an eventTypes change when abilities are empty', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(makeWebhookSub());
      await expect(
        service.update('sub-1', 'user-1', { eventTypes: [WebhookEventType.EventCreated] }, []),
      ).rejects.toThrow(ForbiddenException);
      expect(db.webhookSubscription.update).not.toHaveBeenCalled();
    });

    it('refuses an eventTypes change the caller cannot read', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(makeWebhookSub());
      await expect(
        service.update('sub-1', 'user-1', { eventTypes: [WebhookEventType.EventCreated] }, [denyAll]),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('disable', () => {
    it('sets Disabled status, disabledAt, and redacts', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(makeWebhookSub());
      db.webhookSubscription.update.mockResolvedValue(makeWebhookSub({ secret: 'enc(x)' }));

      const result = await service.disable('sub-1', 'user-1');

      expect(db.webhookSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sub-1' },
          data: expect.objectContaining({ status: WebhookSubscriptionStatus.Disabled, disabledAt: expect.any(Date) }),
        }),
      );

      expect(result.secret).toBe(WEBHOOK_SECRET_REDACTED);
    });
  });

  describe('reactivate', () => {
    it('resets the failure counter, re-checks the read grant, and redacts', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(
        makeWebhookSub({ eventTypes: [makeEventType({ eventType: WebhookEventType.EventCreated })] }),
      );
      db.webhookSubscription.update.mockResolvedValue(makeWebhookSub({ secret: 'enc(x)' }));

      const result = await service.reactivate('sub-1', 'user-1', [allowAll]);

      expect(db.webhookSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: WebhookSubscriptionStatus.Active,
            consecutiveFailures: 0,
            disabledAt: null,
          }),
        }),
      );
      expect(result.secret).toBe(WEBHOOK_SECRET_REDACTED);
    });

    it('refuses to reactivate when the read grant is gone', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(
        makeWebhookSub({ eventTypes: [makeEventType({ eventType: WebhookEventType.EventCreated })] }),
      );
      await expect(service.reactivate('sub-1', 'user-1', [denyAll])).rejects.toThrow(ForbiddenException);
    });

    it('re-checks instance scope and refuses when the resourceId is no longer visible', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(
        makeWebhookSub({
          resourceId: 'event-9',
          eventTypes: [
            makeEventType({
              eventType: WebhookEventType.EventCreated,
            }),
          ],
        }),
      );
      visibility.isVisibleTo.mockResolvedValue(false);

      await expect(service.reactivate('sub-1', 'user-1', [allowAll])).rejects.toThrow(ForbiddenException);
      expect(visibility.isVisibleTo).toHaveBeenCalledWith(ResourceType.Event, 'event-9', allowAll);
      expect(db.webhookSubscription.update).not.toHaveBeenCalled();
    });

    it('re-checks household scope and refuses when the household is no longer readable', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(
        makeWebhookSub({
          resourceType: ResourceType.Event,
          resourceId: null,
          householdId: 'hh-1',
          eventTypes: [makeEventType({ eventType: WebhookEventType.EventCreated })],
        }),
      );
      db.household.count.mockResolvedValue(0);

      await expect(service.reactivate('sub-1', 'user-1', [allowAll])).rejects.toThrow(ForbiddenException);
      expect(db.webhookSubscription.update).not.toHaveBeenCalled();
    });

    it('refuses with no abilities present', async () => {
      await expect(service.reactivate('sub-1', 'user-1', [])).rejects.toThrow(ForbiddenException);
    });
  });

  describe('remove', () => {
    it('soft-deletes and redacts', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(makeWebhookSub());
      db.webhookSubscription.update.mockResolvedValue(makeWebhookSub({ secret: 'enc(x)' }));

      const result = await service.remove('sub-1', 'user-1');

      expect(db.webhookSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
      );
      expect(result.secret).toBe(WEBHOOK_SECRET_REDACTED);
    });
  });
});
