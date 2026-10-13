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
 * v1 ships the Event domain, the household ownership transfer and the
 * game-import lifecycle. The Event and household events fire in apps/api; the
 * import events fire in the worker processes (GameImported / ImportJobFailed /
 * ImportBatchCompleted in apps/worker; ImportJobStarted and fetch-side
 * failures in apps/gateway-worker). All three run the dispatcher.
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
  /** Household ownership changed hands (#158). */
  HouseholdOwnershipTransferred: 'household.ownership.transferred.v1',
} as const;

export type WebhookEventType = (typeof WebhookEventType)[keyof typeof WebhookEventType];

/** The routing/authorization facts a descriptor carries, minus its own name. */
export type WebhookEventMeta = {
  /**
   * CASL subject the event concerns. Drives the coarse create-time
   * `can(requiredAction, subject)` check and the per-instance
   * `accessibleBy(ability, requiredAction)` check at creation and dispatch.
   */
  readonly subject: ResourceType;
  /**
   * Action a subscriber must hold on the subject instance to receive it,
   * checked at creation and again at every dispatch. `read` by default:
   * visibility, not mutation, is the gate, so a read-only member still
   * receives `event.updated.v1`.
   */
  readonly requiredAction: Action;
  /**
   * The event fires after its subject's soft delete has committed, so dispatch
   * checks the deleted row rather than refusing it: the audience is whoever can
   * read that row when the event is dispatched, shortly after the delete. Set
   * only where the emit site follows the delete.
   */
  readonly subjectDeleted?: boolean;
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
 * is the gate); override only for events exposing more sensitive material, and
 * list the override in the registry spec.
 */
export const WEBHOOK_EVENT_DESCRIPTORS: Record<WebhookEventType, WebhookEventMeta> = {
  [WebhookEventType.EventCreated]: { subject: ResourceType.Event, requiredAction: Action.read },
  [WebhookEventType.EventUpdated]: { subject: ResourceType.Event, requiredAction: Action.read },
  // Emitted after the soft delete commits, so a live-row check would refuse
  // every subscriber.
  [WebhookEventType.EventDeleted]: { subject: ResourceType.Event, requiredAction: Action.read, subjectDeleted: true },
  [WebhookEventType.GameImported]: { subject: ResourceType.Game, requiredAction: Action.read },
  [WebhookEventType.ImportJobStarted]: { subject: ResourceType.Job, requiredAction: Action.read },
  [WebhookEventType.ImportJobFailed]: { subject: ResourceType.Job, requiredAction: Action.read },
  [WebhookEventType.ImportBatchCompleted]: { subject: ResourceType.Job, requiredAction: Action.read },
  // `read`, though #158's design called for `update`, reasoning that `read` on
  // Household also admits friends-visibility readers (`read:households:friends`)
  // and that who runs a household is not friends-visible material. It already
  // is: a friend reads the roster of a friends-visible household
  // (`read:household_member:friends`), and the roster names each member's role,
  // `HouseholdOwner` included. `update` would withhold from the webhook what the
  // read already shows (#247). What a push to an outside URL adds over a read is
  // reach, and the payload answers that: ids only, no member identity (see the
  // emit site).
  [WebhookEventType.HouseholdOwnershipTransferred]: {
    subject: ResourceType.Household,
    requiredAction: Action.read,
  },
};

/** Frozen list of every webhook-eligible event name. */
export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = Object.freeze(Object.values(WebhookEventType));

/** Runtime narrowing from an arbitrary emitted event name to the eligible union. */
export function isWebhookEventType(name: string): name is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(name);
}
