import { AuditContextService } from '@bge/actor-context';
import { Action, ResourceType, WebhookSubscription, WebhookSubscriptionStatus } from '@bge/database';
import {
  AbilityFactory,
  PermissionsService,
  type ApikeyWithScopes,
  type AppAbility,
  type UserWithRoles,
} from '@bge/permissions';
import { createTestingModuleWithDb, MockDatabaseService } from '@bge/testing';
import type { WebhookEmittableEvent } from '@bge/webhooks';
import { WebhookEventRegistry, WebhookEventType, WebhookVisibilityService } from '@bge/webhooks';
import { createPrismaAbility } from '@casl/prisma';
import { getQueueToken } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  WEBHOOK_DELIVERY_ATTEMPTS,
  WEBHOOK_GRAPH_READ_BATCH_SIZE,
  WEBHOOK_QUEUE_NAME,
} from '../constants/webhook-queue.constants';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

describe('WebhookDispatcherService', () => {
  let service: WebhookDispatcherService;
  let registry: WebhookEventRegistry;
  let db: MockDatabaseService;
  let queue: { add: jest.Mock };
  let visibility: jest.Mocked<Pick<WebhookVisibilityService, 'isVisibleTo'>>;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getActor'>>;
  let emitter: jest.Mocked<Pick<EventEmitter2, 'onAny' | 'offAny'>>;
  let permissions: jest.Mocked<
    Pick<PermissionsService, 'getUserRoleGraph' | 'loadUserRoleGraphs' | 'loadApiKeyScopeGraphs'>
  >;
  let abilityFactory: jest.Mocked<Pick<AbilityFactory, 'createForUser' | 'createForApiKeyActor'>>;

  const ability = createPrismaAbility([]) as AppAbility;
  const keyAbility = createPrismaAbility([]) as AppAbility;

  const keyGraphOf = (id: string, referenceId = id.replace(/^key-/, 'owner-')) =>
    ({ id, referenceId }) as ApikeyWithScopes;

  const event = (overrides: Partial<WebhookEmittableEvent> = {}): WebhookEmittableEvent => ({
    subjectId: 'event-1',
    householdId: 'hh-1',
    data: { eventId: 'event-1', title: 'Game Night' },
    ...overrides,
  });

  beforeEach(async () => {
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    visibility = { isVisibleTo: jest.fn().mockResolvedValue(true) };
    auditContext = { getActor: jest.fn().mockReturnValue(null) };
    emitter = { onAny: jest.fn(), offAny: jest.fn() };
    permissions = {
      getUserRoleGraph: jest.fn(),
      // Every subscriber is in good standing unless a test says otherwise.
      loadUserRoleGraphs: jest.fn(
        async (ids: readonly string[]) => new Map(ids.map((id) => [id, { id } as UserWithRoles])),
      ),
      // Every key is usable unless a test says otherwise, and `key-N` belongs
      // to `owner-N`.
      loadApiKeyScopeGraphs: jest.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, keyGraphOf(id)]))),
    };
    abilityFactory = {
      createForUser: jest.fn().mockReturnValue(ability),
      createForApiKeyActor: jest.fn<[AppAbility, AppAbility], [AppAbility, ApikeyWithScopes]>((owner) => [
        owner,
        keyAbility,
      ]),
    };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [
        WebhookDispatcherService,
        WebhookEventRegistry,
        { provide: EventEmitter2, useValue: emitter },
        { provide: PermissionsService, useValue: permissions },
        { provide: AbilityFactory, useValue: abilityFactory },
        { provide: WebhookVisibilityService, useValue: visibility },
        { provide: AuditContextService, useValue: auditContext },
        { provide: getQueueToken(WEBHOOK_QUEUE_NAME), useValue: queue },
      ],
    });

    service = module.get(WebhookDispatcherService);
    registry = module.get(WebhookEventRegistry);
    db = mockDb;
  });

  afterEach(() => jest.clearAllMocks());

  // dispatch() is the async core behind the onAny listener; calling it directly
  // avoids the fire-and-forget timing of emitter.emit in tests.
  const dispatch = (name: string, payload: unknown) =>
    (service as unknown as { dispatch(name: string, payload: unknown): Promise<void> }).dispatch(name, payload);

  it('registers on init and unregisters the same handler on shutdown', () => {
    service.onModuleInit();
    const anyListener = emitter.onAny.mock.calls[0][0];

    service.onApplicationShutdown();

    expect(emitter.offAny).toHaveBeenCalledWith(anyListener);
  });

  it('ignores events not in the registry', async () => {
    await dispatch('event.event.created', event()); // unversioned, not registered
    expect(db.webhookSubscription.findMany).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('ignores a registered event whose payload is not a WebhookEmittableEvent', async () => {
    await dispatch(WebhookEventType.EventCreated, { nope: true });
    expect(db.webhookSubscription.findMany).not.toHaveBeenCalled();
  });

  it('queries candidates scoped by subject, status, event type, instance and household', async () => {
    db.webhookSubscription.findMany.mockResolvedValue([]);

    await dispatch(WebhookEventType.EventCreated, event({ subjectId: 'event-1', householdId: 'hh-1' }));

    expect(db.webhookSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: WebhookSubscriptionStatus.Active,
          deletedAt: null,
          resourceType: ResourceType.Event,
          eventTypes: { some: { eventType: WebhookEventType.EventCreated } },
          AND: [
            { OR: [{ resourceId: null }, { resourceId: 'event-1' }] },
            { OR: [{ householdId: null }, { householdId: 'hh-1' }] },
          ],
        }),
        // The key a subscription was made through is judged too (#723).
        select: { id: true, createdById: true, apiKeyId: true },
      }),
    );
  });

  it('matches only null-household subscriptions for a non-household event', async () => {
    db.webhookSubscription.findMany.mockResolvedValue([]);

    await dispatch(WebhookEventType.EventCreated, event({ householdId: null }));

    expect(db.webhookSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ AND: expect.arrayContaining([{ householdId: null }]) }),
      }),
    );
  });

  it('enqueues one delivery per visible subscription with retry/backoff options', async () => {
    db.webhookSubscription.findMany.mockResolvedValue([
      { id: 'sub-1', createdById: 'owner-1', apiKeyId: null },
      { id: 'sub-2', createdById: 'owner-2', apiKeyId: null },
    ] as WebhookSubscription[]);

    await dispatch(WebhookEventType.EventCreated, event());

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        subscriptionId: 'sub-1',
        eventType: WebhookEventType.EventCreated,
        subjectId: 'event-1',
        actor: expect.objectContaining({ kind: 'system' }),
        payload: expect.objectContaining({ type: WebhookEventType.EventCreated, subjectId: 'event-1' }),
      }),
      expect.objectContaining({
        attempts: WEBHOOK_DELIVERY_ATTEMPTS,
        backoff: expect.objectContaining({ type: 'exponential' }),
      }),
    );
  });

  it('derives a deterministic jobId/deliveryId from a stable occurrenceId (idempotent dispatch)', async () => {
    db.webhookSubscription.findMany.mockResolvedValue([
      { id: 'sub-1', createdById: 'owner-1', apiKeyId: null } as WebhookSubscription,
    ]);

    await dispatch(WebhookEventType.EventCreated, event({ occurrenceId: 'mutation-42' }));

    const expectedId = `${WebhookEventType.EventCreated}:sub-1:mutation-42`;
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ deliveryId: expectedId, payload: expect.objectContaining({ id: expectedId }) }),
      expect.objectContaining({ jobId: expectedId }),
    );
  });

  it('falls back to a random jobId when no occurrenceId is supplied', async () => {
    db.webhookSubscription.findMany.mockResolvedValue([
      { id: 'sub-1', createdById: 'owner-1', apiKeyId: null } as WebhookSubscription,
    ]);

    await dispatch(WebhookEventType.EventCreated, event());

    const [, job, opts] = queue.add.mock.calls[0];
    expect(job.deliveryId).not.toContain('sub-1');
    expect(opts.jobId).toBe(job.deliveryId);
  });

  it("builds each subscriber's ability from the graph the database holds now, never the cache (#732)", async () => {
    db.webhookSubscription.findMany.mockResolvedValue([
      { id: 'sub-1', createdById: 'owner-1', apiKeyId: null } as WebhookSubscription,
    ]);
    const graph = { id: 'owner-1' } as UserWithRoles;
    permissions.loadUserRoleGraphs.mockResolvedValue(new Map([['owner-1', graph]]));

    await dispatch(WebhookEventType.EventCreated, event());

    expect(abilityFactory.createForUser).toHaveBeenCalledWith(graph);
    expect(permissions.getUserRoleGraph).not.toHaveBeenCalled();
  });

  // One read for many subscribers, not one each: an event can have many (#732).
  it('reads the graphs of every distinct subscriber in one read per fan-out (#732)', async () => {
    db.webhookSubscription.findMany.mockResolvedValue([
      { id: 'sub-1', createdById: 'owner-1', apiKeyId: null },
      { id: 'sub-2', createdById: 'owner-2', apiKeyId: null },
      { id: 'sub-3', createdById: 'owner-1', apiKeyId: null },
    ] as WebhookSubscription[]);

    await dispatch(WebhookEventType.EventCreated, event());

    expect(permissions.loadUserRoleGraphs).toHaveBeenCalledTimes(1);
    expect(permissions.loadUserRoleGraphs).toHaveBeenCalledWith(['owner-1', 'owner-2']);
  });

  const subscriptionsOfOwners = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `sub-${i}`,
      createdById: `owner-${i}`,
      apiKeyId: null,
    })) as WebhookSubscription[];

  // A graph is large and grows with its user's events, so the graphs held at
  // once are bounded, not the whole fan-out's (#921).
  it('reads the graphs a batch of subscribers at a time (#921)', async () => {
    db.webhookSubscription.findMany.mockResolvedValue(subscriptionsOfOwners(WEBHOOK_GRAPH_READ_BATCH_SIZE + 1));

    await dispatch(WebhookEventType.EventCreated, event());

    const reads = permissions.loadUserRoleGraphs.mock.calls.map(([ids]) => ids);
    expect(reads.map((ids) => ids.length)).toEqual([WEBHOOK_GRAPH_READ_BATCH_SIZE, 1]);
    expect(reads[1]).toEqual([`owner-${WEBHOOK_GRAPH_READ_BATCH_SIZE}`]);
    expect(queue.add).toHaveBeenCalledTimes(WEBHOOK_GRAPH_READ_BATCH_SIZE + 1);
  });

  it('delivers to the subscribers of the other batches when one batch fails to read', async () => {
    db.webhookSubscription.findMany.mockResolvedValue(subscriptionsOfOwners(WEBHOOK_GRAPH_READ_BATCH_SIZE + 1));
    permissions.loadUserRoleGraphs.mockRejectedValueOnce(new Error('db blip'));

    await expect(dispatch(WebhookEventType.EventCreated, event())).resolves.toBeUndefined();

    const delivered = queue.add.mock.calls.map(([, job]) => job.subscriptionId);
    expect(delivered).toEqual([`sub-${WEBHOOK_GRAPH_READ_BATCH_SIZE}`]);
  });

  it('skips a banned or deleted subscriber, who has no graph, without a visibility query (#906)', async () => {
    db.webhookSubscription.findMany.mockResolvedValue([
      { id: 'sub-1', createdById: 'owner-1', apiKeyId: null } as WebhookSubscription,
    ]);
    permissions.loadUserRoleGraphs.mockResolvedValue(new Map());

    await dispatch(WebhookEventType.EventCreated, event());

    expect(abilityFactory.createForUser).not.toHaveBeenCalled();
    expect(visibility.isVisibleTo).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  describe('a webhook subscription made through an API key (#723)', () => {
    it("judges it by its creator's ability and the key's, the key read from the database", async () => {
      db.webhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', createdById: 'owner-1', apiKeyId: 'key-1' },
      ] as WebhookSubscription[]);
      const keyGraph = keyGraphOf('key-1');
      permissions.loadApiKeyScopeGraphs.mockResolvedValue(new Map([['key-1', keyGraph]]));

      await dispatch(WebhookEventType.EventCreated, event());

      expect(permissions.loadApiKeyScopeGraphs).toHaveBeenCalledWith(['key-1']);
      expect(abilityFactory.createForApiKeyActor).toHaveBeenCalledWith(ability, keyGraph);
      expect(visibility.isVisibleTo).toHaveBeenCalledWith(
        ResourceType.Event,
        'event-1',
        [ability, keyAbility],
        expect.anything(),
      );
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('reads the keys of a batch in one read', async () => {
      db.webhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', createdById: 'owner-1', apiKeyId: 'key-1' },
        { id: 'sub-2', createdById: 'owner-2', apiKeyId: 'key-2' },
        { id: 'sub-3', createdById: 'owner-1', apiKeyId: 'key-1' },
        { id: 'sub-4', createdById: 'owner-2', apiKeyId: null },
      ] as WebhookSubscription[]);

      await dispatch(WebhookEventType.EventCreated, event());

      expect(permissions.loadApiKeyScopeGraphs).toHaveBeenCalledTimes(1);
      expect(permissions.loadApiKeyScopeGraphs).toHaveBeenCalledWith(['key-1', 'key-2']);
    });

    it('delivers nothing once its key is deleted, disabled or expired, without a visibility query', async () => {
      db.webhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', createdById: 'owner-1', apiKeyId: 'key-1' },
      ] as WebhookSubscription[]);
      permissions.loadApiKeyScopeGraphs.mockResolvedValue(new Map());

      await dispatch(WebhookEventType.EventCreated, event());

      expect(visibility.isVisibleTo).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    // No request could pair them: a request through a key acts as the key's
    // owner. A row that does anyway fails closed.
    it("delivers nothing through a key that isn't its creator's own, without a visibility query", async () => {
      db.webhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', createdById: 'owner-1', apiKeyId: 'key-2' },
      ] as WebhookSubscription[]);

      await dispatch(WebhookEventType.EventCreated, event());

      expect(abilityFactory.createForApiKeyActor).not.toHaveBeenCalled();
      expect(visibility.isVisibleTo).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("builds a creator's ability once, however many keys they made webhook subscriptions through", async () => {
      db.webhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-session', createdById: 'owner-1', apiKeyId: null },
        { id: 'sub-key-a', createdById: 'owner-1', apiKeyId: 'key-a' },
        { id: 'sub-key-b', createdById: 'owner-1', apiKeyId: 'key-b' },
      ] as WebhookSubscription[]);
      permissions.loadApiKeyScopeGraphs.mockResolvedValue(
        new Map([
          ['key-a', keyGraphOf('key-a', 'owner-1')],
          ['key-b', keyGraphOf('key-b', 'owner-1')],
        ]),
      );

      await dispatch(WebhookEventType.EventCreated, event());

      expect(abilityFactory.createForUser).toHaveBeenCalledTimes(1);
      expect(visibility.isVisibleTo).toHaveBeenCalledTimes(3);
      expect(queue.add).toHaveBeenCalledTimes(3);
    });

    // The memo once keyed on the owner alone, so whichever subscription was
    // judged first answered for the other.
    it.each([
      ['the session’s first', ['sub-session', 'sub-key']],
      ['the key’s first', ['sub-key', 'sub-session']],
    ])('does not let one owner’s session and key subscriptions answer for each other (%s)', async (_order, order) => {
      const rows: Record<string, WebhookSubscription> = {
        'sub-session': { id: 'sub-session', createdById: 'owner-1', apiKeyId: null } as WebhookSubscription,
        'sub-key': { id: 'sub-key', createdById: 'owner-1', apiKeyId: 'key-1' } as WebhookSubscription,
      };
      db.webhookSubscription.findMany.mockResolvedValue(order.map((id) => rows[id]));
      // The owner reaches the subject; the key does not.
      visibility.isVisibleTo.mockImplementation(async (_subject, _id, abilities) => abilities.length === 1);

      await dispatch(WebhookEventType.EventCreated, event());

      expect(queue.add.mock.calls.map(([, job]) => job.subscriptionId)).toEqual(['sub-session']);
    });

    it('delivers nothing to a banned owner, even through a usable key (#906)', async () => {
      db.webhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', createdById: 'owner-1', apiKeyId: 'key-1' },
      ] as WebhookSubscription[]);
      permissions.loadUserRoleGraphs.mockResolvedValue(new Map());

      await dispatch(WebhookEventType.EventCreated, event());

      expect(abilityFactory.createForApiKeyActor).not.toHaveBeenCalled();
      expect(visibility.isVisibleTo).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it("still delivers its batch's session-made webhook subscriptions when the keys fail to read", async () => {
      db.webhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-key', createdById: 'owner-1', apiKeyId: 'key-1' },
        { id: 'sub-session', createdById: 'owner-1', apiKeyId: null },
        { id: 'sub-other', createdById: 'owner-2', apiKeyId: null },
      ] as WebhookSubscription[]);
      permissions.loadApiKeyScopeGraphs.mockRejectedValueOnce(new Error('db blip'));

      await expect(dispatch(WebhookEventType.EventCreated, event())).resolves.toBeUndefined();

      const delivered = queue.add.mock.calls.map(([, job]) => job.subscriptionId);
      expect(delivered).toEqual(['sub-session', 'sub-other']);
    });

    it('drops only its batch when the keys fail to read', async () => {
      const subscriptions = subscriptionsOfOwners(WEBHOOK_GRAPH_READ_BATCH_SIZE + 1).map((row) => ({
        ...row,
        apiKeyId: row.createdById.replace(/^owner-/, 'key-'),
      }));
      db.webhookSubscription.findMany.mockResolvedValue(subscriptions);
      permissions.loadApiKeyScopeGraphs.mockRejectedValueOnce(new Error('db blip'));

      await expect(dispatch(WebhookEventType.EventCreated, event())).resolves.toBeUndefined();

      const delivered = queue.add.mock.calls.map(([, job]) => job.subscriptionId);
      expect(delivered).toEqual([`sub-${WEBHOOK_GRAPH_READ_BATCH_SIZE}`]);
    });
  });

  it('does not enqueue for a subscription whose owner cannot see the subject', async () => {
    db.webhookSubscription.findMany.mockResolvedValue([
      { id: 'sub-1', createdById: 'owner-1', apiKeyId: null } as WebhookSubscription,
    ]);
    visibility.isVisibleTo.mockResolvedValue(false);

    await dispatch(WebhookEventType.EventCreated, event());

    expect(queue.add).not.toHaveBeenCalled();
  });

  it("checks the subject with the descriptor's action (#247)", async () => {
    // Every registered descriptor is `read`, so a stricter one is stood in.
    jest.spyOn(registry, 'require').mockReturnValue({
      type: WebhookEventType.EventUpdated,
      subject: ResourceType.Event,
      requiredAction: Action.update,
    });
    db.webhookSubscription.findMany.mockResolvedValue([
      { id: 'sub-1', createdById: 'owner-1', apiKeyId: null } as WebhookSubscription,
    ]);

    await dispatch(WebhookEventType.EventUpdated, event());

    expect(visibility.isVisibleTo).toHaveBeenCalledWith(ResourceType.Event, 'event-1', [ability], {
      action: Action.update,
      subjectDeleted: false,
    });
  });

  it('checks a delete against the deleted row, still for read (#538)', async () => {
    db.webhookSubscription.findMany.mockResolvedValue([
      { id: 'sub-1', createdById: 'owner-1', apiKeyId: null } as WebhookSubscription,
    ]);

    await dispatch(WebhookEventType.EventDeleted, event());

    expect(visibility.isVisibleTo).toHaveBeenCalledWith(ResourceType.Event, 'event-1', [ability], {
      action: Action.read,
      subjectDeleted: true,
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('checks every other event against the live row', async () => {
    db.webhookSubscription.findMany.mockResolvedValue([
      { id: 'sub-1', createdById: 'owner-1', apiKeyId: null } as WebhookSubscription,
    ]);

    await dispatch(WebhookEventType.EventCreated, event());

    expect(visibility.isVisibleTo).toHaveBeenCalledWith(ResourceType.Event, 'event-1', [ability], {
      action: Action.read,
      subjectDeleted: false,
    });
  });

  it('carries the CLS actor when present', async () => {
    auditContext.getActor.mockReturnValue({ kind: 'user', userId: 'user-7' });
    db.webhookSubscription.findMany.mockResolvedValue([
      { id: 'sub-1', createdById: 'owner-1', apiKeyId: null } as WebhookSubscription,
    ]);

    await dispatch(WebhookEventType.EventCreated, event());

    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ actor: { kind: 'user', userId: 'user-7' } }),
      expect.any(Object),
    );
  });

  it('does not let a fan-out error escape into the emitter', async () => {
    db.webhookSubscription.findMany.mockRejectedValue(new Error('db down'));
    await expect(dispatch(WebhookEventType.EventCreated, event())).resolves.toBeUndefined();
  });

  it('isolates a failed enqueue so the remaining subscribers still receive the event', async () => {
    db.webhookSubscription.findMany.mockResolvedValue([
      { id: 'sub-1', createdById: 'owner-1', apiKeyId: null },
      { id: 'sub-2', createdById: 'owner-2', apiKeyId: null },
      { id: 'sub-3', createdById: 'owner-3', apiKeyId: null },
    ] as WebhookSubscription[]);
    // sub-2's enqueue fails (transient Redis blip); sub-1 and sub-3 must still enqueue.
    queue.add
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('redis blip'))
      .mockResolvedValueOnce(undefined);

    await expect(dispatch(WebhookEventType.EventCreated, event())).resolves.toBeUndefined();

    // All three were attempted — the failure of sub-2 did not abort the loop.
    expect(queue.add).toHaveBeenCalledTimes(3);
    const attempted = queue.add.mock.calls.map(([, job]) => job.subscriptionId);
    expect(attempted).toEqual(['sub-1', 'sub-2', 'sub-3']);
  });
});
