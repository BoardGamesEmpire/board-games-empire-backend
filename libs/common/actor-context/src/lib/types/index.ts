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

/**
 * Consent-unit scope types, mirroring the Prisma `PluginGrantScope` enum
 * values by string identity. Mirrored rather than imported: this lib is
 * framework-light and beneath `@bge/database`, so it must not pull the
 * generated client in. The permissions lib (which imports both) is where the
 * two meet, and its plugin grant read path fails to compile if they drift.
 */
export const PLUGIN_UNIT_SCOPE_TYPES = ['Server', 'Household', 'User'] as const;
export type PluginUnitScopeType = (typeof PLUGIN_UNIT_SCOPE_TYPES)[number];

/**
 * The consent unit a plugin actor is operating AS (#60) — the
 * coordinates ability resolution intersects `PluginGrant` rows against and
 * renders CASL condition templates with (the `unit.*` context).
 *
 * A discriminated union rather than a flat optional-fields shape: each
 * scope type carries EXACTLY the coordinate it owns, so an invalid unit
 * (Household without its householdId, Server smuggling one) is
 * unrepresentable at compile time and consumers narrow instead of casting.
 * {@link isPluginUnit} enforces the same rules at trust boundaries where
 * the value arrives untyped.
 *
 * A boot-time load has no unit to operate for and uses
 * {@link SERVER_PLUGIN_UNIT}; household/user units are entered
 * per-invocation by whatever dispatches into the plugin.
 */
export type PluginUnit = ServerPluginUnit | HouseholdPluginUnit | UserPluginUnit;

export interface ServerPluginUnit {
  readonly scopeType: 'Server';
  readonly householdId?: never;
  readonly userId?: never;
}

export interface HouseholdPluginUnit {
  readonly scopeType: 'Household';
  readonly householdId: string;
  readonly userId?: never;
}

export interface UserPluginUnit {
  readonly scopeType: 'User';
  readonly userId: string;
  readonly householdId?: never;
}

/** The unit-less default every plugin operates as outside a household/user invocation. */
export const SERVER_PLUGIN_UNIT: ServerPluginUnit = Object.freeze({ scopeType: 'Server' });

/**
 * Structural + coordinate-rule validation for a {@link PluginUnit}. Used at
 * the trust boundaries that mint or deserialize plugin actors (the CLS
 * scope service, the gRPC inbound interceptor) — a malformed unit must fail
 * there, loudly, not surface later as a grant lookup that quietly matches
 * nothing or the wrong scope.
 */
export function isPluginUnit(value: unknown): value is PluginUnit {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const unit = value as { scopeType?: unknown; householdId?: unknown; userId?: unknown };

  const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0;

  switch (unit.scopeType) {
    case 'Server':
      return unit.householdId === undefined && unit.userId === undefined;
    case 'Household':
      return validId(unit.householdId) && unit.userId === undefined;
    case 'User':
      return validId(unit.userId) && unit.householdId === undefined;
    default:
      return false;
  }
}

/**
 * The throwing form of {@link isPluginUnit} for the in-process ingress
 * points (the CLS scope service, feature-state, consent presentation):
 * one `RangeError` shape instead of a copy per site. Boundaries owing a
 * transport-appropriate error (the gRPC interceptor's `BadRequestException`,
 * the queue host's `UnrecoverableError`) keep their own.
 */
export function assertPluginUnit(unit: unknown, context: string): asserts unit is PluginUnit {
  if (!isPluginUnit(unit)) {
    throw new RangeError(
      `${context} received an invalid plugin unit ${JSON.stringify(unit)}: ` +
        'expected Server (no coordinates), Household (householdId only), or User (userId only)',
    );
  }
}

/**
 * Detached, frozen copy of a (valid) unit carrying ONLY the coordinate its
 * scope type owns — absent coordinates are absent keys, not
 * `undefined`-valued ones. The single canonicalization used everywhere a
 * unit crosses a boundary: minting the CLS actor, reconstructing from wire
 * metadata, projecting onto the plugin contract view, and building the
 * ability render context (where key-presence is what the fail-loud walk
 * checks). Callers validate with {@link isPluginUnit} first; this only
 * copies. Exhaustive over the union — a new scope type fails to compile
 * here instead of silently cloning to nothing.
 */
export function clonePluginUnit(unit: PluginUnit): PluginUnit {
  switch (unit.scopeType) {
    case 'Server':
      return Object.freeze({ scopeType: 'Server' });
    case 'Household':
      return Object.freeze({ scopeType: 'Household', householdId: unit.householdId });
    case 'User':
      return Object.freeze({ scopeType: 'User', userId: unit.userId });
    default:
      return assertNeverPluginUnit(unit);
  }
}

/**
 * Exhaustiveness guard for {@link PluginUnit} dispatch. The union is closed;
 * a forged scope type at runtime (or a future variant missing a branch)
 * fails LOUD here — a consent-unit dispatch must never fall through to a
 * permissive default.
 */
export function assertNeverPluginUnit(unit: never): never {
  throw new RangeError(`Unhandled plugin unit scope type: ${JSON.stringify(unit)}`);
}

/**
 * The actor kinds a trigger chain may terminate in — every variant except
 * `plugin`, which is always another link, never the end. `satisfies` couples
 * the list to the `Actor` union: adding a variant fails compilation here
 * until the boundary verdict below accounts for it.
 */
const TERMINAL_ACTOR_KINDS: ReadonlySet<unknown> = new Set(
  Object.keys({
    user: true,
    anonymous: true,
    apiKey: true,
    system: true,
    external: true,
  } satisfies Record<Exclude<ActorKind, 'plugin'>, true>),
);

/**
 * Whether every plugin actor in a (possibly nested) trigger chain carries a
 * valid consent unit AND the chain terminates in a recognized non-plugin
 * actor. Boundaries that deserialize whole actors (the queue envelope, wire
 * metadata) use this so a malformed actor ANYWHERE in the chain is rejected
 * at the boundary — the nested trigger is projected onto the plugin contract
 * view level by level, so a hole one hop deep would otherwise surface as a
 * deep error far from the ingress.
 */
export function actorHasValidPluginUnits(actor: Actor): boolean {
  // Deserialized input can violate the Actor type at runtime (an envelope
  // with a missing trigger, a non-object where an actor belongs). This
  // function is the boundary's verdict, so it must return false for those —
  // throwing a TypeError here would escape as an ordinary error and turn
  // "reject the malformed envelope" into an endlessly retried job.
  let current: Actor | undefined = actor;

  while (current !== null && typeof current === 'object' && isPluginActor(current)) {
    if (!isPluginUnit(current.unit)) {
      return false;
    }

    current = current.trigger;
  }

  // The chain must terminate in a recognized non-plugin actor. Object-ness
  // alone is not enough: a terminator without a known `kind` would pass the
  // boundary only to throw UnknownActorKindError deep in the contract-view
  // projection — the far-from-ingress failure this verdict exists to
  // prevent. The gRPC boundary already rejects unknown kinds level by
  // level; this keeps the queue verdict in parity.
  return current !== null && typeof current === 'object' && TERMINAL_ACTOR_KINDS.has(current.kind);
}

export interface PluginActor {
  readonly kind: 'plugin';
  readonly pluginId: string;
  /**
   * The consent unit the plugin is operating as. Authority-bearing (unlike
   * `trigger`): ability resolution scopes grants and condition templates to
   * these coordinates (#60).
   */
  readonly unit: PluginUnit;
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
