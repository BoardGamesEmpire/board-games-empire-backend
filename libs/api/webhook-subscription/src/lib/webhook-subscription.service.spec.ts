import { Action, Prisma, ResourceType, WebhookSubscriptionEventType, WebhookSubscriptionStatus } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, ScopeComposer, type AppAbility } from '@bge/permissions';
import { EncryptionService } from '@bge/services';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  MOCK_RESOURCE_CONDITION,
  MockAbilityService,
  MockDatabaseService,
  rawQueryText,
  unwrapTransaction,
} from '@bge/testing';
import {
  CreateWebhookSubscriptionDto,
  WebhookEventRegistry,
  WebhookEventType,
  WebhookVisibilityService,
} from '@bge/webhooks';
import { createPrismaAbility } from '@casl/prisma';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WEBHOOK_SECRET_REDACTED, WebhookSubscriptionService } from './webhook-subscription.service';

type WebhookWithEvents = Prisma.WebhookSubscriptionGetPayload<{ include: { eventTypes: true } }>;

const ACTING_USER_ID = 'user-1';

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
    createdById: ACTING_USER_ID,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    eventTypes: [],
    ...overrides,
  };
}

describe('WebhookSubscriptionService', () => {
  let service: WebhookSubscriptionService;
  let registry: WebhookEventRegistry;
  let db: MockDatabaseService;
  let visibility: jest.Mocked<Pick<WebhookVisibilityService, 'isVisibleTo'>>;
  let encryption: jest.Mocked<Pick<EncryptionService, 'encrypt' | 'decrypt'>>;
  let ability: MockAbilityService;
  let compose: jest.SpyInstance;

  const allowAll = createPrismaAbility([{ action: Action.manage, subject: 'all' }]) as AppAbility;
  const denyAll = createPrismaAbility([]) as AppAbility;

  /** Sets the abilities the service will read from `getCurrentAbilities()`. */
  const primeAbilities = (...abilities: AppAbility[]) => ability.getCurrentAbilities.mockReturnValue(abilities);

  beforeEach(async () => {
    visibility = { isVisibleTo: jest.fn().mockResolvedValue(true) };
    // Deterministic, reversible stand-in so we can assert "ciphertext stored,
    // plaintext revealed" without real crypto.
    encryption = {
      encrypt: jest.fn((plain: string) => `enc(${plain})`),
      decrypt: jest.fn((cipher: string) => cipher.replace(/^enc\(|\)$/g, '')),
    };
    // Acting user + abilities now come from CLS via AbilityService, not method
    // params. Default to the owner with full access; per-test overrides narrow it.
    ability = createMockAbilityService();
    ability.getActingUserId.mockReturnValue(ACTING_USER_ID);
    primeAbilities(allowAll);

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [
        WebhookSubscriptionService,
        WebhookEventRegistry,
        // The REAL composer, over the mocked ability service, so the list's
        // where clause asserted below is the merge the read actually runs.
        ScopeComposer,
        { provide: WebhookVisibilityService, useValue: visibility },
        { provide: EncryptionService, useValue: encryption },
        { provide: AbilityService, useValue: ability },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('development-secret') } },
      ],
    });

    service = module.get(WebhookSubscriptionService);
    registry = module.get(WebhookEventRegistry);
    compose = jest.spyOn(module.get(ScopeComposer), 'compose');
    db = mockDb;
    // Create writes inside a transaction (#552). The household share lock is
    // its one raw statement, and it finds the household live unless a case
    // says otherwise.
    unwrapTransaction(db);
    db.$queryRaw.mockResolvedValue([{ id: 'hh-1' }] as never);
  });

  /**
   * Every registered descriptor requires `read`, so a stricter one is stood in:
   * `EventUpdated` requires `update`, and every other type keeps its own.
   */
  const requireUpdateForEventUpdated = () => {
    const descriptorOf = registry.require.bind(registry);
    jest
      .spyOn(registry, 'require')
      .mockImplementation((type) =>
        type === WebhookEventType.EventUpdated
          ? { ...descriptorOf(type), requiredAction: Action.update }
          : descriptorOf(type),
      );
  };

  afterEach(() => jest.clearAllMocks());

  function baseDto(overrides: Partial<CreateWebhookSubscriptionDto> = {}): CreateWebhookSubscriptionDto {
    return {
      url: 'https://hooks.example.com/bge',
      resourceType: ResourceType.Event,
      eventTypes: [WebhookEventType.EventCreated, WebhookEventType.EventUpdated],
      ...overrides,
    };
  }

  describe('create', () => {
    it('stores the secret encrypted and reveals the generated plaintext exactly once', async () => {
      db.webhookSubscription.create.mockResolvedValue(makeWebhookSub());

      const result = await service.create(baseDto());

      // Stored ciphertext is the encrypted form of a freshly generated whsec_ secret.
      expect(encryption.encrypt).toHaveBeenCalledWith(expect.stringMatching(/^whsec_/));
      expect(db.webhookSubscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            url: 'https://hooks.example.com/bge',
            status: WebhookSubscriptionStatus.Active,
            secret: expect.stringMatching(/^enc\(whsec_/),
            createdBy: { connect: { id: ACTING_USER_ID } },
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

      const result = await service.create(baseDto({ secret: 'whsec_caller_supplied_secret_value' }));

      expect(encryption.encrypt).toHaveBeenCalledWith('whsec_caller_supplied_secret_value');
      expect(db.webhookSubscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ secret: 'enc(whsec_caller_supplied_secret_value)' }),
        }),
      );
      expect(result.secret).toBe('whsec_caller_supplied_secret_value');
    });

    it('rejects when the caller cannot read the subject (CASL-at-create)', async () => {
      primeAbilities(denyAll);
      await expect(service.create(baseDto())).rejects.toThrow(ForbiddenException);
      expect(db.webhookSubscription.create).not.toHaveBeenCalled();
      expect(encryption.encrypt).not.toHaveBeenCalled();
    });

    it('rejects when no abilities are present', async () => {
      primeAbilities();
      await expect(service.create(baseDto())).rejects.toThrow(ForbiddenException);
      expect(db.webhookSubscription.create).not.toHaveBeenCalled();
    });

    it('requires every ability in the intersection to permit the subject', async () => {
      primeAbilities(allowAll, denyAll);
      await expect(service.create(baseDto())).rejects.toThrow(ForbiddenException);
    });

    it('rejects an event type that does not belong to the declared resource', async () => {
      const dto = baseDto({ resourceType: ResourceType.Game, eventTypes: [WebhookEventType.EventCreated] });
      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });

    it('checks instance visibility when resourceId is scoped', async () => {
      db.webhookSubscription.create.mockResolvedValue(makeWebhookSub());
      await service.create(baseDto({ resourceId: 'event-9' }));
      expect(visibility.isVisibleTo).toHaveBeenCalledWith(ResourceType.Event, 'event-9', allowAll, {
        action: Action.read,
      });
    });

    it("checks the scoped instance with each requested type's action (#247)", async () => {
      requireUpdateForEventUpdated();
      db.webhookSubscription.create.mockResolvedValue(makeWebhookSub());

      await service.create(baseDto({ resourceId: 'event-9' }));

      // One check per distinct action, not per type.
      expect(visibility.isVisibleTo.mock.calls).toEqual([
        [ResourceType.Event, 'event-9', allowAll, { action: Action.read }],
        [ResourceType.Event, 'event-9', allowAll, { action: Action.update }],
      ]);
    });

    it('refuses an instance the caller can read but not take the stricter action on', async () => {
      requireUpdateForEventUpdated();
      visibility.isVisibleTo.mockImplementation(
        async (_subject, _id, _ability, options) => options?.action !== Action.update,
      );

      await expect(service.create(baseDto({ resourceId: 'event-9' }))).rejects.toThrow(ForbiddenException);
      expect(db.webhookSubscription.create).not.toHaveBeenCalled();
    });

    it('checks the household for read whatever the types require', async () => {
      // The household is the subscription's container, not its subject: the
      // check asks whether the caller can see it at all.
      requireUpdateForEventUpdated();
      const eventsAndReadHousehold = createPrismaAbility([
        { action: Action.manage, subject: ResourceType.Event },
        { action: Action.read, subject: ResourceType.Household },
      ]) as AppAbility;
      primeAbilities(eventsAndReadHousehold);
      db.household.count.mockResolvedValue(1);
      db.webhookSubscription.create.mockResolvedValue(makeWebhookSub());

      await service.create(baseDto({ householdId: 'hh-1' }));

      // `{}` is the clause for an unconditioned rule. Checked for `update`, the
      // clause would be the deny-all `{ OR: [] }`.
      expect(db.household.count).toHaveBeenCalledWith({ where: { id: 'hh-1', deletedAt: null, AND: [{}] } });
    });

    it('rejects when the scoped instance is not visible', async () => {
      visibility.isVisibleTo.mockResolvedValue(false);
      await expect(service.create(baseDto({ resourceId: 'event-9' }))).rejects.toThrow(ForbiddenException);
    });

    it('checks household readability when householdId is scoped', async () => {
      db.household.count.mockResolvedValue(0);
      await expect(service.create(baseDto({ householdId: 'hh-1' }))).rejects.toThrow(ForbiddenException);
    });

    describe('a household soft-deleted while the create is in flight (#552)', () => {
      beforeEach(() => {
        db.household.count.mockResolvedValue(1);
        db.webhookSubscription.create.mockResolvedValue(makeWebhookSub({ householdId: 'hh-1' }));
      });

      it("takes the household's share lock in the create's transaction, before the write", async () => {
        await service.create(baseDto({ householdId: 'hh-1' }));

        expect(db.$transaction).toHaveBeenCalledTimes(1);
        const [query] = db.$queryRaw.mock.calls[0];
        expect(rawQueryText(query)).toMatch(/FROM households h[\s\S]*FOR SHARE/);
        expect(query).toEqual(expect.objectContaining({ values: ['hh-1'] }));
        expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
          db.webhookSubscription.create.mock.invocationCallOrder[0],
        );
      });

      it('answers 403 once the lock finds the household gone, and writes nothing', async () => {
        // The readability check ran before the transaction and saw it live. A
        // request that loses the race gets the answer one arriving just after
        // the delete gets from that check: forbidden_household, not a 404.
        db.$queryRaw.mockResolvedValue([] as never);

        const refusal = service.create(baseDto({ householdId: 'hh-1' }));

        await expect(refusal).rejects.toThrow(ForbiddenException);
        await expect(refusal).rejects.toThrow(/forbidden_household/);
        expect(db.webhookSubscription.create).not.toHaveBeenCalled();
      });

      it('takes no household lock for a subscription that names no household', async () => {
        db.webhookSubscription.create.mockResolvedValue(makeWebhookSub());

        await service.create(baseDto());

        expect(db.$queryRaw).not.toHaveBeenCalled();
        expect(db.webhookSubscription.create).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('reads redact the secret', () => {
    it('getById never returns the stored ciphertext', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(makeWebhookSub({ secret: 'enc(whsec_x)' }));
      const result = await service.getById('sub-1');
      expect(result.secret).toBe(WEBHOOK_SECRET_REDACTED);
    });

    it('list redacts every row', async () => {
      db.webhookSubscription.findMany.mockResolvedValue([
        makeWebhookSub({ id: 'sub-1', secret: 'enc(whsec_a)' }),
        makeWebhookSub({ id: 'sub-2', secret: 'enc(whsec_b)' }),
      ]);
      const result = await service.list();
      expect(result.map((s) => s.secret)).toEqual([WEBHOOK_SECRET_REDACTED, WEBHOOK_SECRET_REDACTED]);
    });
  });

  /**
   * #515. The list declares its own set, the acting user's live
   * subscriptions, and the ceiling clips it. It used to filter on the owner
   * and ask for no ceiling at all, so an API key scoped to one subscription
   * listed every subscription its owner had.
   */
  describe('list', () => {
    it("asks the composer for its where clause, declaring the acting user's live subscriptions", async () => {
      db.webhookSubscription.findMany.mockResolvedValue([]);

      await service.list();

      expect(compose).toHaveBeenCalledWith(ResourceType.WebhookSubscription, Action.read, {
        createdById: ACTING_USER_ID,
        deletedAt: null,
      });
      expect(db.webhookSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { createdById: ACTING_USER_ID, deletedAt: null, AND: [MOCK_RESOURCE_CONDITION] },
        }),
      );
    });

    // PROVISIONAL (#395). "My subscriptions" has no meaning for an actor with
    // no user behind it, and the refusal must not soften into an empty list.
    it('refuses an actor kind with no user behind it, with a message about reading', async () => {
      ability.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
      });

      const rejection: unknown = await service.list().catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.access'));
      expect(db.webhookSubscription.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('scopes by the acting user and throws NotFound when absent', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(null);
      await expect(service.getById('sub-x')).rejects.toThrow(NotFoundException);
      expect(db.webhookSubscription.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sub-x', createdById: ACTING_USER_ID, deletedAt: null } }),
      );
    });
  });

  describe('update', () => {
    it('re-encrypts and reveals a rotated secret', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(makeWebhookSub());
      db.webhookSubscription.update.mockResolvedValue(makeWebhookSub());

      const result = await service.update('sub-1', { secret: 'whsec_rotated_value_1234567890' });

      expect(encryption.encrypt).toHaveBeenCalledWith('whsec_rotated_value_1234567890');
      expect(db.webhookSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ secret: 'enc(whsec_rotated_value_1234567890)' }) }),
      );
      expect(result.secret).toBe('whsec_rotated_value_1234567890');
    });

    it('redacts when the update does not rotate the secret', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(makeWebhookSub());

      db.webhookSubscription.update.mockResolvedValue(makeWebhookSub());

      const result = await service.update('sub-1', { url: 'https://new.example.com/hook' });

      expect(db.webhookSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ secret: undefined }) }),
      );
      expect(result.secret).toBe(WEBHOOK_SECRET_REDACTED);
    });

    it('throws when the DTO is empty', async () => {
      await expect(service.update('sub-1', {})).rejects.toThrow(BadRequestException);
    });

    it('refuses an eventTypes change when abilities are empty', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(makeWebhookSub());
      primeAbilities();
      await expect(service.update('sub-1', { eventTypes: [WebhookEventType.EventCreated] })).rejects.toThrow(
        ForbiddenException,
      );
      expect(db.webhookSubscription.update).not.toHaveBeenCalled();
    });

    it("re-checks a scoped instance with the new types' actions (#247)", async () => {
      // A type that requires more than the subscription's current ones must not
      // be added by PATCH past the check creation would have run.
      requireUpdateForEventUpdated();
      db.webhookSubscription.findFirst.mockResolvedValue(makeWebhookSub({ resourceId: 'event-9' }));
      visibility.isVisibleTo.mockResolvedValue(false);

      await expect(service.update('sub-1', { eventTypes: [WebhookEventType.EventUpdated] })).rejects.toThrow(
        ForbiddenException,
      );
      expect(visibility.isVisibleTo).toHaveBeenCalledWith(ResourceType.Event, 'event-9', allowAll, {
        action: Action.update,
      });
      expect(db.webhookSubscription.update).not.toHaveBeenCalled();
    });

    it('leaves an unscoped subscription to the subject check on an eventTypes change', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(makeWebhookSub());
      db.webhookSubscription.update.mockResolvedValue(makeWebhookSub());

      await service.update('sub-1', { eventTypes: [WebhookEventType.EventUpdated] });

      expect(visibility.isVisibleTo).not.toHaveBeenCalled();
    });

    it('refuses an eventTypes change the caller cannot read', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(makeWebhookSub());
      primeAbilities(denyAll);
      await expect(service.update('sub-1', { eventTypes: [WebhookEventType.EventCreated] })).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('disable', () => {
    it('sets Disabled status, disabledAt, and redacts', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(makeWebhookSub());
      db.webhookSubscription.update.mockResolvedValue(makeWebhookSub({ secret: 'enc(x)' }));

      const result = await service.disable('sub-1');

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
    it("resets the failure counter, re-checks each type's action, and redacts", async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(
        makeWebhookSub({ eventTypes: [makeEventType({ eventType: WebhookEventType.EventCreated })] }),
      );
      db.webhookSubscription.update.mockResolvedValue(makeWebhookSub({ secret: 'enc(x)' }));

      const result = await service.reactivate('sub-1');

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

    it("refuses to reactivate when a type's action is no longer granted", async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(
        makeWebhookSub({ eventTypes: [makeEventType({ eventType: WebhookEventType.EventCreated })] }),
      );
      primeAbilities(denyAll);
      await expect(service.reactivate('sub-1')).rejects.toThrow(ForbiddenException);
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

      await expect(service.reactivate('sub-1')).rejects.toThrow(ForbiddenException);
      expect(visibility.isVisibleTo).toHaveBeenCalledWith(ResourceType.Event, 'event-9', allowAll, {
        action: Action.read,
      });
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

      await expect(service.reactivate('sub-1')).rejects.toThrow(ForbiddenException);
      expect(db.webhookSubscription.update).not.toHaveBeenCalled();
    });

    it('refuses with no abilities present', async () => {
      primeAbilities();
      await expect(service.reactivate('sub-1')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('remove', () => {
    it('soft-deletes and redacts', async () => {
      db.webhookSubscription.findFirst.mockResolvedValue(makeWebhookSub());
      db.webhookSubscription.update.mockResolvedValue(makeWebhookSub({ secret: 'enc(x)' }));

      const result = await service.remove('sub-1');

      expect(db.webhookSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
      );
      expect(result.secret).toBe(WEBHOOK_SECRET_REDACTED);
    });
  });
});
