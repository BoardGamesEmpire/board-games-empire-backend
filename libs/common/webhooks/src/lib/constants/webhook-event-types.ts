/**
 * Webhook event taxonomy.
 *
 * Convention (CONVENTIONS source of truth): `<domain>.<entity>.<action>.v<N>`,
 * lower-case, dot-delimited, always version-suffixed. The version bumps only on
 * a breaking change to the delivered body shape; additive fields do not bump it.
 *
 * These are the *wire* names — what receivers see in `X-BGE-Event` and what a
 * `WebhookSubscription` stores in its `eventTypes` join rows. They are matched
 * verbatim by the dispatcher against the names domain code emits, so the two
 * must stay in lockstep: adding an entry here without an emit site (or vice
 * versa) is a no-op, not a silent partial feature.
 *
 * v1 ships the Event domain only. Game-domain events (`game.game.imported.v1`,
 * `game.game.updated.v1`) are intentionally absent until their emit sites —
 * which fire in the worker process, not the API — adopt the
 * `WebhookEmittableEvent` envelope and the dispatcher is wired into the worker.
 * See the registry for where they slot in.
 */
export const WebhookEventType = {
  EventCreated: 'event.event.created.v1',
  EventUpdated: 'event.event.updated.v1',
  EventDeleted: 'event.event.deleted.v1',
} as const;

export type WebhookEventType = (typeof WebhookEventType)[keyof typeof WebhookEventType];

/** Frozen list of every webhook-eligible event name. */
export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = Object.freeze(Object.values(WebhookEventType));

/** Runtime narrowing from an arbitrary emitted event name to the eligible union. */
export function isWebhookEventType(name: string): name is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(name);
}
