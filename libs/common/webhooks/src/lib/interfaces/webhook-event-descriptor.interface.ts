import type { Action, ResourceType } from '@bge/database';
import type { WebhookEventType } from '../constants/webhook-event-types';

/**
 * Static, code-defined metadata for one webhook event type. Pure authorization
 * and routing facts — no payload handling lives here (that comes off the
 * `WebhookEmittableEvent` instance at dispatch), so the descriptor needs no
 * generic and the registry stays a flat, fully-typed map.
 *
 * - `subject`        CASL subject the event concerns. Drives the coarse
 *                    create-time `can(requiredAction, subject)` check and the
 *                    per-instance `accessibleBy(...).ofType(subject)` check at
 *                    dispatch.
 * - `requiredAction` Grant a subscriber must hold to receive this event.
 *                    Defaults to `read` — visibility, not mutation, is the gate
 *                    (a read-only member still receives `event.updated.v1`).
 *                    Override only for events exposing more sensitive material.
 */
export interface WebhookEventDescriptor {
  readonly type: WebhookEventType;
  readonly subject: ResourceType;
  readonly requiredAction: Action;
}
