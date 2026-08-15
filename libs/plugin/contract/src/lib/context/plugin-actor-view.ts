/**
 * Structural, host-independent view of the actor a plugin may observe
 * through `PluginContext.actor`.
 *
 * This deliberately mirrors the readable surface of the host's `Actor`
 * union (`@bge/actor-context`) WITHOUT importing it: this lib is buildable
 * and intended for plugin authors, while the host union lives in a private,
 * source-only workspace lib that a publishable contract must not reference.
 * The runtime lib (`@bge/plugin`) carries a drift spec asserting the host
 * union is assignable to this view, so the two shapes cannot silently
 * diverge — the same enforcement pattern the manifest lib uses for the
 * Prisma `Action` verbs and the reserved lifecycle slugs, and for the same
 * reason (the lower lib cannot import the source of truth).
 *
 * Structural assignability means additive host changes never break plugins,
 * and a rename or removal breaks the drift spec at compile time. It does NOT
 * by itself keep undeclared host fields away from plugins — the host copies
 * field-by-field onto this shape before handing it over
 * (`plugin-actor-view.projection.ts` in `@bge/plugin`). Anything absent here
 * is absent at runtime because of that projection, not because of the type.
 */
export type PluginActorView =
  | UserActorView
  | AnonymousActorView
  | ApiKeyActorView
  | SystemActorView
  | ExternalActorView
  | PluginChainActorView;

/** Authenticated registered user via session. */
export interface UserActorView {
  readonly kind: 'user';
  readonly userId: string;
}

/** Anonymous-auth user (same user row, unverified identity). */
export interface AnonymousActorView {
  readonly kind: 'anonymous';
  readonly userId: string;
}

/** Authenticated via API key; carries both the key id and the owning user. */
export interface ApiKeyActorView {
  readonly kind: 'apiKey';
  readonly apiKeyId: string;
  readonly userId: string;
}

/** Internal host origin with no user (boot, scheduled tasks, cascades). */
export interface SystemActorView {
  readonly kind: 'system';
  readonly reason: string;
}

/** Foreign system identified by `system` + `identifier` (e.g. remote gateways). */
export interface ExternalActorView {
  readonly kind: 'external';
  readonly system: string;
  readonly identifier: string;
}

/**
 * The consent unit a plugin actor is operating as (#60): `Server` outside
 * any household/user invocation, otherwise the coordinates of the unit
 * whose grants scope the current work. A discriminated union — the same
 * "exactly one coordinate accompanies its scope type" rule the host's
 * `PluginUnit` enforces, mirrored structurally here because the contract
 * lib stays dependency-free: a `Server` view with a `householdId` is
 * unrepresentable rather than merely documented away.
 *
 * Like every field on this view, it is a frozen, point-in-time DTO — a
 * projection of what was true when the host entered the plugin scope, not
 * a live handle. It never re-resolves; a plugin holding one across
 * asynchronous work observes the unit the scope was entered with.
 */
export type PluginUnitView = ServerPluginUnitView | HouseholdPluginUnitView | UserPluginUnitView;

export interface ServerPluginUnitView {
  readonly scopeType: 'Server';
  readonly householdId?: never;
  readonly userId?: never;
}

export interface HouseholdPluginUnitView {
  readonly scopeType: 'Household';
  readonly householdId: string;
  readonly userId?: never;
}

export interface UserPluginUnitView {
  readonly scopeType: 'User';
  readonly userId: string;
  readonly householdId?: never;
}

/**
 * Plugin code executing on behalf of a `trigger` actor. Recursive: a plugin
 * observing the chain can walk `trigger` back to the originating principal.
 * The trigger is audit attribution only — never an authority source (#59);
 * `unit` is the authority-bearing coordinate set (#60).
 */
export interface PluginChainActorView {
  readonly kind: 'plugin';
  readonly pluginId: string;
  readonly unit: PluginUnitView;
  readonly trigger: PluginActorView;
}
