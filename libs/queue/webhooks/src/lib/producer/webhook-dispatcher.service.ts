import { AuditContextService, type Actor } from '@bge/actor-context';
import { DatabaseService, Prisma, ResourceType, WebhookSubscriptionStatus } from '@bge/database';
import {
  AbilityFactory,
  PermissionsService,
  type ApikeyWithScopes,
  type AppAbility,
  type UserWithRoles,
} from '@bge/permissions';
import {
  WebhookEventRegistry,
  WebhookVisibilityService,
  isWebhookEmittableEvent,
  type WebhookEmittableEvent,
  type WebhookEventDescriptor,
  type WebhookEventType,
} from '@bge/webhooks';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import {
  WEBHOOK_DELIVERY_ATTEMPTS,
  WEBHOOK_DELIVERY_BACKOFF_MS,
  WEBHOOK_DELIVERY_JOB,
  WEBHOOK_FAILED_JOB_RETENTION,
  WEBHOOK_GRAPH_READ_BATCH_SIZE,
  WEBHOOK_QUEUE_NAME,
} from '../constants/webhook-queue.constants';
import type { WebhookDeliveryJob } from '../interfaces/webhook-delivery-job.interface';

/** One matching webhook subscription, and the API key it was made through. */
interface CandidateSubscription {
  readonly id: string;
  readonly apiKeyId: string | null;
}

/**
 * One subscriber being judged: their graph, and their ability once a webhook
 * subscription of theirs has needed it, so it is built once however many keys
 * they made webhook subscriptions through.
 */
interface Subscriber {
  readonly graph: UserWithRoles;
  ability?: AppAbility;
}

/**
 * Bridges domain events to webhook deliveries — the queue *producer*. Runs in
 * every process that emits eligible events: the API (the Event domain and the
 * household ownership transfer), the worker (import completion, failure and
 * batch completion) and the gateway-worker (import start and fetch failure).
 * It listens to every emitted event via `onAny` (the emitter is configured
 * `wildcard: false`, so `@OnEvent('**')` would never fire), filters to
 * registered types, then for each matching subscription re-checks the owner's
 * live ability before enqueuing a delivery job.
 *
 * Authorization is CASL-at-dispatch: a subscription receives an event only if
 * its creator can currently take the descriptor's `requiredAction` on the
 * subject instance. Each subscriber's ability is built from the graph the
 * database holds when the event is dispatched, never the cache, so a grant the
 * emitting write changed counts whether or not anything evicted the
 * subscriber's graph first (#732). The read sees only what has committed, so
 * every emit must follow its write's commit. A subscriber under a ban has no
 * graph and receives nothing (#906). Subscribers' graphs are read a batch of
 * subscribers at a time (#921), and each ability is built once per subscriber.
 *
 * A webhook subscription made through an API key is judged by its creator's
 * ability and the key's together, as a request through that key is, with the
 * key read from the database too. Once the key is deleted, disabled or
 * expired, that webhook subscription receives nothing (#723).
 *
 * The handler never throws into the emitter — a webhook failure must not break
 * the domain transaction that produced the event.
 */
@Injectable()
export class WebhookDispatcherService implements OnModuleInit, OnApplicationShutdown {
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

  // Not onModuleDestroy: the server still takes requests then, and a mutation
  // in that window would commit without its webhook delivery (#673).
  onApplicationShutdown(): void {
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
    // The descriptor and subjectId are loop-invariant, so visibility is a pure
    // function of the subscriber and the key — memoize per pair so a
    // subscriber with several matching webhook subscriptions through one key,
    // or none, costs one visibility query, not one each.
    const visibilityCache = new Map<string, boolean>();
    const subscriptionsByOwner = new Map<string, CandidateSubscription[]>();
    for (const { id, createdById, apiKeyId } of subscriptions) {
      const candidates = subscriptionsByOwner.get(createdById);
      if (candidates) {
        candidates.push({ id, apiKeyId });
      } else {
        subscriptionsByOwner.set(createdById, [{ id, apiKeyId }]);
      }
    }
    const owners = [...subscriptionsByOwner.entries()];
    let failures = 0;

    // A batch of owners at a time, so the graphs held at once stay bounded
    // however many subscribe (#921), and a failed read loses only its batch.
    for (let start = 0; start < owners.length; start += WEBHOOK_GRAPH_READ_BATCH_SIZE) {
      const batch = owners.slice(start, start + WEBHOOK_GRAPH_READ_BATCH_SIZE);

      // The keys are read beside the graphs, but a failed key read drops only
      // the webhook subscriptions made through a key (#723).
      const [graphRead, keyRead] = await Promise.allSettled([
        this.permissions.loadUserRoleGraphs(batch.map(([ownerId]) => ownerId)),
        this.permissions.loadApiKeyScopeGraphs(this.apiKeyIdsOf(batch)),
      ]);

      if (graphRead.status === 'rejected') {
        const err: unknown = graphRead.reason;
        const dropped = batch.reduce((count, [, candidates]) => count + candidates.length, 0);
        failures += dropped;
        this.logger.error(
          `Failed to read the permissions of ${batch.length} webhook subscribers on "${eventType}" ` +
            `(subject ${event.subjectId}), dropping ${dropped} deliveries: ${err instanceof Error ? err.message : err}`,
          err instanceof Error ? err.stack : undefined,
        );
        continue;
      }

      const graphs = graphRead.value;
      const keyGraphs = keyRead.status === 'fulfilled' ? keyRead.value : null;
      if (keyRead.status === 'rejected') {
        const err: unknown = keyRead.reason;
        this.logger.error(
          `Failed to read the API keys of ${batch.length} webhook subscribers on "${eventType}" ` +
            `(subject ${event.subjectId}), dropping the deliveries made through a key: ` +
            `${err instanceof Error ? err.message : err}`,
          err instanceof Error ? err.stack : undefined,
        );
      }

      for (const [ownerId, candidates] of batch) {
        // A banned or deleted subscriber has no graph, so nothing to judge and
        // no delivery (#906).
        const graph = graphs.get(ownerId);
        if (!graph) {
          continue;
        }

        const subscriber: Subscriber = { graph };
        for (const { id: subscriptionId, apiKeyId } of candidates) {
          let keyGraph: ApikeyWithScopes | null | undefined = null;
          if (apiKeyId !== null) {
            if (!keyGraphs) {
              // Its batch's key read failed, and said so above.
              failures += 1;
              continue;
            }
            keyGraph = keyGraphs.get(apiKeyId);
          }

          // Isolate each subscription: a single failed enqueue (e.g. a transient
          // Redis blip on queue.add) or visibility lookup must NOT abort the fan-out
          // and silently strip the event from every subscriber later in the list.
          // Log the one that failed and carry on so deliveries are independent.
          try {
            const visible = await this.visibleTo(
              subscriber,
              apiKeyId,
              keyGraph,
              descriptor,
              event.subjectId,
              visibilityCache,
            );

            if (!visible) {
              continue;
            }

            await this.enqueue(subscriptionId, eventType, event, actor);
          } catch (err) {
            failures += 1;
            this.logger.error(
              `Failed to enqueue webhook delivery for subscription ${subscriptionId} on "${eventType}" ` +
                `(subject ${event.subjectId}): ${err instanceof Error ? err.message : err}`,
              err instanceof Error ? err.stack : undefined,
            );
          }
        }
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
      select: { id: true, createdById: true, apiKeyId: true },
    });
  }

  /** The distinct keys a batch's webhook subscriptions were made through. */
  private apiKeyIdsOf(batch: readonly (readonly [string, CandidateSubscription[]])[]): string[] {
    const keys = new Set<string>();
    for (const [, candidates] of batch) {
      for (const { apiKeyId } of candidates) {
        if (apiKeyId !== null) {
          keys.add(apiKeyId);
        }
      }
    }

    return [...keys];
  }

  /**
   * Whether the subscriber, through the key when the webhook subscription was
   * made through one, can take the descriptor's action on the subject.
   * `keyGraph` is `null` for one the subscriber's session made, and
   * `undefined` once its key is deleted, disabled or expired.
   */
  private async visibleTo(
    subscriber: Subscriber,
    apiKeyId: string | null,
    keyGraph: ApikeyWithScopes | null | undefined,
    descriptor: WebhookEventDescriptor,
    subjectId: string,
    cache: Map<string, boolean>,
  ): Promise<boolean> {
    // A subscriber's session and each of their keys reach different rows, so
    // each pair is its own verdict (#723).
    const memoKey = `${subscriber.graph.id}:${apiKeyId ?? ''}`;
    const cached = cache.get(memoKey);
    if (cached !== undefined) {
      return cached;
    }

    // Nothing left to judge it by once the key is gone. A key that isn't its
    // subscriber's own is refused too: a request through a key always acts as
    // the key's owner, so no request could have made that pairing.
    if (keyGraph === undefined || (keyGraph !== null && keyGraph.referenceId !== subscriber.graph.id)) {
      cache.set(memoKey, false);
      return false;
    }

    subscriber.ability ??= this.abilityFactory.createForUser(subscriber.graph);
    const abilities =
      keyGraph === null ? [subscriber.ability] : this.abilityFactory.createForApiKeyActor(subscriber.ability, keyGraph);

    const visible = await this.visibility.isVisibleTo(descriptor.subject, subjectId, abilities, {
      action: descriptor.requiredAction,
      subjectDeleted: descriptor.subjectDeleted ?? false,
    });
    cache.set(memoKey, visible);
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
