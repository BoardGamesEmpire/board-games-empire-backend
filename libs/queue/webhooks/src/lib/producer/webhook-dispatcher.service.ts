import { AuditContextService, type Actor } from '@bge/actor-context';
import { DatabaseService, Prisma, ResourceType, WebhookSubscriptionStatus } from '@bge/database';
import { AbilityFactory, PermissionsService } from '@bge/permissions';
import {
  WebhookEventRegistry,
  WebhookVisibilityService,
  isWebhookEmittableEvent,
  type WebhookEmittableEvent,
  type WebhookEventType,
} from '@bge/webhooks';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import {
  WEBHOOK_DELIVERY_ATTEMPTS,
  WEBHOOK_DELIVERY_BACKOFF_MS,
  WEBHOOK_DELIVERY_JOB,
  WEBHOOK_FAILED_JOB_RETENTION,
  WEBHOOK_QUEUE_NAME,
} from '../constants/webhook-queue.constants';
import type { WebhookDeliveryJob } from '../interfaces/webhook-delivery-job.interface';

/**
 * Bridges domain events to webhook deliveries — the queue *producer*. Runs in
 * any process that emits eligible events (API for the Event domain today; the
 * worker too, once game-domain events are eligible). It listens to every
 * emitted event via `onAny` (the emitter is configured `wildcard: false`, so
 * `@OnEvent('**')` would never fire), filters to registered types, then for
 * each matching subscription re-checks the owner's live read ability before
 * enqueuing a delivery job.
 *
 * Authorization is CASL-at-dispatch: a subscription receives an event only if
 * its creator can currently read the subject instance. The owner's ability is
 * built per dispatch and memoized for the burst, since `getUserRoleGraph` is
 * cached but `createForUser` is not.
 *
 * The handler never throws into the emitter — a webhook failure must not break
 * the domain transaction that produced the event.
 */
@Injectable()
export class WebhookDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDispatcherService.name);

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly db: DatabaseService,
    private readonly registry: WebhookEventRegistry,
    private readonly permissions: PermissionsService,
    private readonly abilityFactory: AbilityFactory,
    private readonly visibility: WebhookVisibilityService,
    private readonly auditContext: AuditContextService,
    @InjectQueue(WEBHOOK_QUEUE_NAME) private readonly queue: Queue<WebhookDeliveryJob>,
  ) {}

  onModuleInit(): void {
    this.emitter.onAny(this.anyListener);
  }

  onModuleDestroy(): void {
    this.emitter.offAny(this.anyListener);
  }

  // Arrow property so `this` is bound for on/offAny registration.
  private readonly anyListener = (event: string | string[], payload: unknown): void => {
    const name = Array.isArray(event) ? event.join('.') : event;
    void this.dispatch(name, payload);
  };

  private async dispatch(eventName: string, payload: unknown): Promise<void> {
    if (!this.registry.has(eventName)) {
      return;
    }
    if (!isWebhookEmittableEvent(payload)) {
      return this.logger.warn(
        `Registered webhook event "${eventName}" emitted a payload missing the WebhookEmittableEvent shape; skipping`,
      );
    }

    try {
      await this.fanOut(eventName, payload);
    } catch (err) {
      this.logger.error(
        `Webhook dispatch failed for "${eventName}" (subject ${payload.subjectId}): ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  private async fanOut(eventType: WebhookEventType, event: WebhookEmittableEvent): Promise<void> {
    const descriptor = this.registry.require(eventType);
    const subscriptions = await this.candidateSubscriptions(eventType, descriptor.subject, event);
    if (subscriptions.length === 0) {
      return;
    }

    const actor = this.auditContext.getActor() ?? this.unattributedActor();
    // subject + subjectId are loop-invariant, so visibility is a pure function of
    // the owner — memoize per createdById so an owner with multiple matching
    // subscriptions costs one ability build + one visibility query, not one each.
    const visibilityCache = new Map<string, boolean>();
    let failures = 0;

    for (const subscription of subscriptions) {
      // Isolate each subscription: a single failed enqueue (e.g. a transient
      // Redis blip on queue.add) or visibility lookup must NOT abort the fan-out
      // and silently strip the event from every subscriber later in the list.
      // Log the one that failed and carry on so deliveries are independent.
      try {
        const visible = await this.visibleTo(
          subscription.createdById,
          descriptor.subject,
          event.subjectId,
          visibilityCache,
        );

        if (!visible) {
          continue;
        }

        await this.enqueue(subscription.id, eventType, event, actor);
      } catch (err) {
        failures += 1;
        this.logger.error(
          `Failed to enqueue webhook delivery for subscription ${subscription.id} on "${eventType}" ` +
            `(subject ${event.subjectId}): ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (failures > 0) {
      this.logger.warn(
        `Webhook fan-out for "${eventType}" (subject ${event.subjectId}): ` +
          `${failures}/${subscriptions.length} deliveries failed to enqueue and were dropped`,
      );
    }
  }

  private candidateSubscriptions(eventType: WebhookEventType, subject: ResourceType, event: WebhookEmittableEvent) {
    const householdFilter: Prisma.WebhookSubscriptionWhereInput =
      event.householdId === null
        ? { householdId: null }
        : { OR: [{ householdId: null }, { householdId: event.householdId }] };

    return this.db.webhookSubscription.findMany({
      where: {
        status: WebhookSubscriptionStatus.Active,
        deletedAt: null,
        resourceType: subject,
        eventTypes: { some: { eventType } },
        AND: [{ OR: [{ resourceId: null }, { resourceId: event.subjectId }] }, householdFilter],
      },
      select: { id: true, createdById: true },
    });
  }

  private async visibleTo(
    userId: string,
    subject: ResourceType,
    subjectId: string,
    cache: Map<string, boolean>,
  ): Promise<boolean> {
    const cached = cache.get(userId);
    if (cached !== undefined) {
      return cached;
    }
    const graph = await this.permissions.getUserRoleGraph(userId);
    const ability = this.abilityFactory.createForUser(graph);
    const visible = await this.visibility.isVisibleTo(subject, subjectId, ability);
    cache.set(userId, visible);
    return visible;
  }
  private async enqueue(
    subscriptionId: string,
    eventType: WebhookEventType,
    event: WebhookEmittableEvent,
    actor: Actor,
  ): Promise<void> {
    // Idempotency: when the emit site supplies a stable occurrenceId, derive a
    // deterministic jobId so a re-emitted event dedups to one delivery (BullMQ
    // ignores an add whose jobId is still present). The deliveryId — the
    // receiver's idempotency key — is the same value, so the receiver can dedup
    // too. Absent an occurrenceId, fall back to a random id (no dedup) rather
    // than a key that would wrongly collapse two distinct events.
    // @todo(#56-idempotency): once the emit-site migration lands, require a
    //   stable occurrenceId (audit/mutation row id) for webhook-eligible events
    //   so duplicate deliveries are impossible rather than best-effort.
    const deliveryId = event.occurrenceId ? `${eventType}:${subscriptionId}:${event.occurrenceId}` : randomUUID();

    const job: WebhookDeliveryJob = {
      deliveryId,
      subscriptionId,
      eventType,
      subjectId: event.subjectId,
      actor,
      payload: {
        id: deliveryId,
        type: eventType,
        occurredAt: new Date().toISOString(),
        subjectId: event.subjectId,
        // @todo(#56-pii): `data` is trusted as PII-safe per the
        //   WebhookEmittableEvent contract — copied verbatim to a user-controlled
        //   URL. When emit sites are wired, add a central allowlist/redaction
        //   guardrail so one careless emit site can't exfiltrate fields.
        data: event.data,
      },
    };

    await this.queue.add(WEBHOOK_DELIVERY_JOB, job, {
      jobId: deliveryId,
      attempts: WEBHOOK_DELIVERY_ATTEMPTS,
      backoff: { type: 'exponential', delay: WEBHOOK_DELIVERY_BACKOFF_MS },
      removeOnComplete: true,
      // Keep a bounded tail of terminally-failed jobs for inspection instead of
      // retaining them in Redis forever.
      removeOnFail: { count: WEBHOOK_FAILED_JOB_RETENTION },
    });
  }

  private unattributedActor(): Actor {
    return { kind: 'system', reason: 'webhook:unattributed-event' };
  }
}
