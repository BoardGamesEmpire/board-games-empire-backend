import type { ResourceType } from '@bge/database';
import { Injectable } from '@nestjs/common';
import { WEBHOOK_EVENT_DESCRIPTORS, WebhookEventType } from '../constants/webhook-event-types';
import type { WebhookEventDescriptor } from '../interfaces/webhook-event-descriptor.interface';

/**
 * Injectable view over the code-defined event catalogue. The keystone of the
 * subsystem: it gates which emitted events the dispatcher acts on, supplies the
 * subject for the create-time CASL check, and (via `requiredAction`) sets the
 * grant a subscriber must hold.
 *
 * Stateless and constant — no DB. Registered global so both the API-side
 * dispatcher/subscription service and (when wired) the worker-side dispatcher
 * resolve against the same table.
 *
 * The descriptors are NOT hand-maintained here anymore: they are derived from
 * the compiler-enforced `WEBHOOK_EVENT_DESCRIPTORS` (a `Record` over
 * `WebhookEventType`), colocated with the wire names. That removes the old
 * "second parallel edit" — a name with no descriptor is now a build error, not
 * a silent dispatch no-op. Adding an event still needs an emit site that fires
 * the name carrying a `WebhookEmittableEvent`.
 */
@Injectable()
export class WebhookEventRegistry {
  private readonly descriptors: ReadonlyMap<WebhookEventType, WebhookEventDescriptor> = new Map<
    WebhookEventType,
    WebhookEventDescriptor
  >(
    (Object.entries(WEBHOOK_EVENT_DESCRIPTORS) as [WebhookEventType, (typeof WEBHOOK_EVENT_DESCRIPTORS)[WebhookEventType]][]).map(
      ([type, meta]) => [type, { type, ...meta }],
    ),
  );

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
