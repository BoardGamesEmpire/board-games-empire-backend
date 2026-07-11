import { Action, ResourceType } from '@bge/database';

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
 * v1 ships the Event domain and the game-import lifecycle. The import events
 * fire in the worker processes (GameImported / ImportJobFailed /
 * ImportBatchCompleted in apps/worker; ImportJobStarted and fetch-side
 * failures in apps/gateway-worker), both of which run the dispatcher.
 * `game.game.updated.v1` remains absent until enrichment adopts the
 * `WebhookEmittableEvent` envelope.
 */
export const WebhookEventType = {
  EventCreated: 'event.event.created.v1',
  EventUpdated: 'event.event.updated.v1',
  EventDeleted: 'event.event.deleted.v1',
  /** A game (base or expansion) was persisted by an import job. */
  GameImported: 'game.game.imported.v1',
  /** An import job began fetching from its gateway. */
  ImportJobStarted: 'game.import.started.v1',
  /** An import job failed terminally (all retries exhausted). */
  ImportJobFailed: 'game.import.failed.v1',
  /** Every job in an import batch reached a terminal status. */
  ImportBatchCompleted: 'game.import-batch.completed.v1',
} as const;

export type WebhookEventType = (typeof WebhookEventType)[keyof typeof WebhookEventType];

/** The routing/authorization facts a descriptor carries, minus its own name. */
export type WebhookEventMeta = {
  /** CASL subject the event concerns (drives the create-time + dispatch checks). */
  readonly subject: ResourceType;
  /** Grant a subscriber must hold to receive it — `read` (visibility) by default. */
  readonly requiredAction: Action;
};

/**
 * The single companion to {@link WebhookEventType}: every event's static
 * routing/authorization facts, keyed by wire name.
 *
 * Typed `Record<WebhookEventType, …>`, so the compiler REQUIRES exactly one
 * entry per event name — a name with no descriptor (or a descriptor with no
 * name) is a build error, not the silent dispatch no-op it used to be when the
 * registry maintained a hand-written parallel map. Adding an event is a name
 * above plus a line here, kept in lockstep by the type system.
 *
 * `WebhookEventRegistry` is a thin, injectable view over this table.
 *
 * Import lifecycle events use `Job` as their subject — the import Job row is
 * the thing a subscriber observes (gated by `read:job`); `GameImported` uses
 * `Game`, since by then the game exists and game read-visibility is the right
 * audience test. `requiredAction` defaults to `read` (visibility, not mutation,
 * is the gate); override only for events exposing more sensitive material.
 */
export const WEBHOOK_EVENT_DESCRIPTORS: Record<WebhookEventType, WebhookEventMeta> = {
  [WebhookEventType.EventCreated]: { subject: ResourceType.Event, requiredAction: Action.read },
  [WebhookEventType.EventUpdated]: { subject: ResourceType.Event, requiredAction: Action.read },
  [WebhookEventType.EventDeleted]: { subject: ResourceType.Event, requiredAction: Action.read },
  [WebhookEventType.GameImported]: { subject: ResourceType.Game, requiredAction: Action.read },
  [WebhookEventType.ImportJobStarted]: { subject: ResourceType.Job, requiredAction: Action.read },
  [WebhookEventType.ImportJobFailed]: { subject: ResourceType.Job, requiredAction: Action.read },
  [WebhookEventType.ImportBatchCompleted]: { subject: ResourceType.Job, requiredAction: Action.read },
};

/** Frozen list of every webhook-eligible event name. */
export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = Object.freeze(Object.values(WebhookEventType));

/** Runtime narrowing from an arbitrary emitted event name to the eligible union. */
export function isWebhookEventType(name: string): name is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(name);
}
