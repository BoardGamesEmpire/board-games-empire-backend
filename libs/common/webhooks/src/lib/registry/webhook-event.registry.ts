import { Action, ResourceType } from '@bge/database';
import { Injectable } from '@nestjs/common';
import { WebhookEventType } from '../constants/webhook-event-types';
import type { WebhookEventDescriptor } from '../interfaces/webhook-event-descriptor.interface';

/**
 * Code-defined catalogue of every webhook-eligible event. The keystone of the
 * subsystem: it gates which emitted events the dispatcher acts on, supplies the
 * subject for the create-time CASL check, and (via `requiredAction`) sets the
 * grant a subscriber must hold.
 *
 * Stateless and constant — no DB. Registered global so both the API-side
 * dispatcher/subscription service and (when wired) the worker-side dispatcher
 * resolve against the same table.
 *
 * Adding an event is two coordinated edits: a name in `WebhookEventType` + an
 * entry here, and an emit site that fires that name carrying a
 * `WebhookEmittableEvent`.
 *
 * Import lifecycle events use `Job` as their subject — the import Job row is
 * the thing a subscriber observes (gated by `read:job`); `GameImported` uses
 * `Game`, since by then the game exists and game read-visibility is the right
 * audience test.
 */
@Injectable()
export class WebhookEventRegistry {
  private readonly descriptors: ReadonlyMap<WebhookEventType, WebhookEventDescriptor> = new Map<
    WebhookEventType,
    WebhookEventDescriptor
  >([
    [
      WebhookEventType.EventCreated,
      { type: WebhookEventType.EventCreated, subject: ResourceType.Event, requiredAction: Action.read },
    ],
    [
      WebhookEventType.EventUpdated,
      { type: WebhookEventType.EventUpdated, subject: ResourceType.Event, requiredAction: Action.read },
    ],
    [
      WebhookEventType.EventDeleted,
      { type: WebhookEventType.EventDeleted, subject: ResourceType.Event, requiredAction: Action.read },
    ],
    [
      WebhookEventType.GameImported,
      { type: WebhookEventType.GameImported, subject: ResourceType.Game, requiredAction: Action.read },
    ],
    [
      WebhookEventType.ImportJobStarted,
      { type: WebhookEventType.ImportJobStarted, subject: ResourceType.Job, requiredAction: Action.read },
    ],
    [
      WebhookEventType.ImportJobFailed,
      { type: WebhookEventType.ImportJobFailed, subject: ResourceType.Job, requiredAction: Action.read },
    ],
    [
      WebhookEventType.ImportBatchCompleted,
      { type: WebhookEventType.ImportBatchCompleted, subject: ResourceType.Job, requiredAction: Action.read },
    ],
  ]);

  /**
   * True when `name` is a registered, deliverable event type.
   */
  has(name: string): name is WebhookEventType {
    return this.descriptors.has(name as WebhookEventType);
  }

  /** Descriptor for a known type, or `undefined`. */
  get(type: WebhookEventType): WebhookEventDescriptor | undefined {
    return this.descriptors.get(type);
  }

  /**
   * Descriptor for a known type, throwing if absent. Use where a missing entry
   * is a programmer error rather than untrusted input (fail loudly).
   */
  require(type: WebhookEventType): WebhookEventDescriptor {
    const descriptor = this.descriptors.get(type);
    if (!descriptor) {
      throw new Error(`No webhook event descriptor registered for "${type}"`);
    }

    return descriptor;
  }

  /** Distinct subjects across the requested types — for the create-time check. */
  subjectsFor(types: readonly WebhookEventType[]): ResourceType[] {
    const subjects = new Set<ResourceType>();
    for (const type of types) {
      subjects.add(this.require(type).subject);
    }

    return Array.from(subjects);
  }

  /** Every registered event type. */
  types(): WebhookEventType[] {
    return Array.from(this.descriptors.keys());
  }
}
