import type { MutationEvent } from '@bge/actor-context';
import type { WebhookEmittableEvent, WebhookEventType } from '@bge/webhooks';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { HouseholdEvents } from '../constants/household-events.constant';

/** A household change's webhook: its versioned wire name, and the envelope sent under it. */
export interface HouseholdWebhook {
  /** Ids only: `data` is copied verbatim to a subscriber-controlled URL (#248). */
  readonly envelope: WebhookEmittableEvent<unknown>;

  readonly type: WebhookEventType;
}

/**
 * The one way the household lib announces a committed change (#245): the
 * domain event, which the audit persistence listener's `onAny` records as an
 * audit entry, then the change's webhook event type, when it has one. Two
 * separate emits, mirroring the game-import processors.
 *
 * Called only AFTER commit. A webhook or audit failure must never roll back
 * the change, and a delivery describing a transaction that later aborted
 * would be worse than a missing one.
 *
 * Each emit is guarded on its own. `EventEmitterModule` runs without
 * `ignoreErrors`, so a listener registered on the emitter itself (`onAny`, as
 * the audit persistence listener is) that throws synchronously propagates out
 * of `emit()`. The caller sits inside its mutation's try block, so the throw
 * would be classified as unexpected and answered as a 500 for a change that
 * committed, and whose ability caches may already be evicted. The client
 * would then retry into a refusal, as a repeated ownership transfer meets a
 * 400 "already an owner" (#248). A throw is logged instead, naming what was
 * lost, and never rethrown; a throw from the domain event's listener doesn't
 * stop the webhook. A listener declared with `@OnEvent` never reaches the
 * guard: Nest wraps it and logs its failure.
 *
 * Logged rather than swallowed: a missing audit entry is a real problem, just
 * not one the caller can act on or retry away. Audit entries are best-effort,
 * written after commit; making them durable is #1415.
 */
@Injectable()
export class HouseholdEventPublisher {
  private readonly logger = new Logger(HouseholdEventPublisher.name);

  constructor(private readonly events: EventEmitter2) {}

  publish(name: HouseholdEvents, event: MutationEvent<unknown>, webhook?: HouseholdWebhook): void {
    this.emitGuarded(name, event, event);

    if (webhook) {
      this.emitGuarded(webhook.type, webhook.envelope, event);
    }
  }

  /**
   * Emits one payload under `name`, logging a listener's throw with `name`, so
   * the log says which emit was lost: the domain event or the webhook.
   *
   * The error's message goes in the log string and its stack goes as a string
   * second argument, Nest's `(message, stack)` contract: nestjs-pino maps that
   * to `err`, but hands an `Error` object to pino as a printf argument, which
   * drops it when the message has no placeholder.
   */
  private emitGuarded(name: string, payload: unknown, event: MutationEvent<unknown>): void {
    try {
      this.events.emit(name, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      const summary = `A listener failed for ${name} (${event.subject} ${event.subjectId}) after the change committed: ${message}`;

      if (stack === undefined) {
        this.logger.error(summary);
      } else {
        this.logger.error(summary, stack);
      }
    }
  }
}
