/**
 * Discriminated union of actors recognized by the audit/event system.
 *
 * Variants:
 * - `user`: authenticated registered user via session
 * - `anonymous`: BetterAuth anonymous-plugin user (same User row, isAnonymous=true)
 * - `apiKey`: authenticated via x-api-key header; carries both key id and owner id
 * - `system`: internal origin with no user (migrations, scheduled tasks, cascade jobs)
 * - `external`: foreign system identified by `system` + `identifier`
 *                (e.g. gateway services calling over gRPC)
 * - `plugin`: plugin code executing on behalf of a `trigger` actor (recursive).
 *             Type lands now; no populator until plugin loader exists.
 */
export type Actor = UserActor | AnonymousActor | ApiKeyActor | SystemActor | ExternalActor | PluginActor;

export interface UserActor {
  readonly kind: 'user';
  readonly userId: string;
}

export interface AnonymousActor {
  readonly kind: 'anonymous';
  readonly userId: string;
}

export interface ApiKeyActor {
  readonly kind: 'apiKey';
  readonly apiKeyId: string;
  readonly userId: string;
}

export interface SystemActor {
  readonly kind: 'system';
  readonly reason: string;
}

export interface ExternalActor {
  readonly kind: 'external';
  readonly system: string;
  readonly identifier: string;
}

export interface PluginActor {
  readonly kind: 'plugin';
  readonly pluginId: string;
  readonly trigger: Actor;
}

export type ActorKind = Actor['kind'];

/**
 * Origin transport for an event. Derived at the entry-point interceptor and
 * carried via CLS; emit sites never specify it directly.
 */
export type EventSource = 'http' | 'grpc' | 'queue' | 'ws' | 'system';

/**
 * Metadata attached to every event. `auditable` is a class-level concern set by
 * the `@Auditable` decorator. `source` and `correlationId` are derived from CLS.
 */
export interface EventMeta {
  readonly auditable: boolean;
  readonly source: EventSource;
  readonly correlationId?: string;
}

export const isUserActor = (actor: Actor): actor is UserActor => actor.kind === 'user';
export const isAnonymousActor = (actor: Actor): actor is AnonymousActor => actor.kind === 'anonymous';
export const isApiKeyActor = (actor: Actor): actor is ApiKeyActor => actor.kind === 'apiKey';
export const isSystemActor = (actor: Actor): actor is SystemActor => actor.kind === 'system';
export const isExternalActor = (actor: Actor): actor is ExternalActor => actor.kind === 'external';
export const isPluginActor = (actor: Actor): actor is PluginActor => actor.kind === 'plugin';

/**
 * Walks a (possibly nested) `plugin` actor chain and returns the originating
 * non-plugin trigger. Returns the actor as-is for non-plugin variants.
 */
export function resolveTrigger(actor: Actor): Exclude<Actor, PluginActor> {
  let current: Actor = actor;

  while (isPluginActor(current)) {
    current = current.trigger;
  }

  return current;
}

/**
 * Returns the owning `userId` when the actor variant carries one, otherwise
 * `null`. Useful for forensic lookups without per-variant branching.
 */
export function actorUserId(actor: Actor): string | null {
  const root = resolveTrigger(actor);

  switch (root.kind) {
    case 'user':
    case 'anonymous':
    case 'apiKey':
      return root.userId;
    case 'system':
    case 'external':
      return null;
    default:
      // Closed union today; guards against a forged/future actor kind
      // returning `undefined` in violation of the `string | null` contract.
      return null;
  }
}
