import { AuditContextService } from '@bge/actor-context';
import { ResourceType, WebhookSubscription, WebhookSubscriptionStatus } from '@bge/database';
import { AbilityFactory, PermissionsService, type AppAbility } from '@bge/permissions';
import { createTestingModuleWithDb, MockDatabaseService } from '@bge/testing';
import type { WebhookEmittableEvent } from '@bge/webhooks';
import { WebhookEventRegistry, WebhookEventType, WebhookVisibilityService } from '@bge/webhooks';
import { createPrismaAbility } from '@casl/prisma';
import { getQueueToken } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WEBHOOK_DELIVERY_ATTEMPTS, WEBHOOK_QUEUE_NAME } from '../constants/webhook-queue.constants';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

describe('WebhookDispatcherService', () => {
  let service: WebhookDispatcherService;
  let db: MockDatabaseService;
  let queue: { add: jest.Mock };
  let visibility: jest.Mocked<Pick<WebhookVisibilityService, 'isVisibleTo'>>;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getActor'>>;

  const ability = createPrismaAbility([]) as AppAbility;

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

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [
        WebhookDispatcherService,
        WebhookEventRegistry,
        { provide: EventEmitter2, useValue: { onAny: jest.fn(), offAny: jest.fn() } },
        { provide: PermissionsService, useValue: { getUserRoleGraph: jest.fn().mockResolvedValue({}) } },
        { provide: AbilityFactory, useValue: { createForUser: jest.fn().mockReturnValue(ability) } },
        { provide: WebhookVisibilityService, useValue: visibility },
        { provide: AuditContextService, useValue: auditContext },
        { provide: getQueueToken(WEBHOOK_QUEUE_NAME), useValue: queue },
      ],
    });

    service = module.get(WebhookDispatcherService);
    db = mockDb;
  });

  afterEach(() => jest.clearAllMocks());

  // dispatch() is the async core behind the onAny listener; calling it directly
  // avoids the fire-and-forget timing of emitter.emit in tests.
  const dispatch = (name: string, payload: unknown) =>
    (service as unknown as { dispatch(name: string, payload: unknown): Promise<void> }).dispatch(name, payload);

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
      { id: 'sub-1', createdById: 'owner-1' },
      { id: 'sub-2', createdById: 'owner-2' },
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
    db.webhookSubscription.findMany.mockResolvedValue([{ id: 'sub-1', createdById: 'owner-1' } as WebhookSubscription]);

    await dispatch(WebhookEventType.EventCreated, event({ occurrenceId: 'mutation-42' }));

    const expectedId = `${WebhookEventType.EventCreated}:sub-1:mutation-42`;
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ deliveryId: expectedId, payload: expect.objectContaining({ id: expectedId }) }),
      expect.objectContaining({ jobId: expectedId }),
    );
  });

  it('falls back to a random jobId when no occurrenceId is supplied', async () => {
    db.webhookSubscription.findMany.mockResolvedValue([{ id: 'sub-1', createdById: 'owner-1' } as WebhookSubscription]);

    await dispatch(WebhookEventType.EventCreated, event());

    const [, job, opts] = queue.add.mock.calls[0];
    expect(job.deliveryId).not.toContain('sub-1');
    expect(opts.jobId).toBe(job.deliveryId);
  });

  it('does not enqueue for a subscription whose owner cannot see the subject', async () => {
    db.webhookSubscription.findMany.mockResolvedValue([{ id: 'sub-1', createdById: 'owner-1' } as WebhookSubscription]);
    visibility.isVisibleTo.mockResolvedValue(false);

    await dispatch(WebhookEventType.EventCreated, event());

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('carries the CLS actor when present', async () => {
    auditContext.getActor.mockReturnValue({ kind: 'user', userId: 'user-7' });
    db.webhookSubscription.findMany.mockResolvedValue([{ id: 'sub-1', createdById: 'owner-1' } as WebhookSubscription]);

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
      { id: 'sub-1', createdById: 'owner-1' },
      { id: 'sub-2', createdById: 'owner-2' },
      { id: 'sub-3', createdById: 'owner-3' },
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
