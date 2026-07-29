/**
 * Typed failures for the plugin context surface (#59 Phase B).
 *
 * Unlike the loader errors, this one deliberately DOES cross into plugin
 * code: it is thrown from `PluginContext.actor.current()`. Returning `null`
 * instead would be indistinguishable from an unauthenticated context and
 * would let a de-synced or forged CLS actor read as "nobody" — the loud
 * failure is the safer signal for both sides.
 */

/**
 * The CLS actor carries a `kind` outside the host `Actor` union, so no
 * projection onto `PluginActorView` is defined for it. A closed union means
 * this is unreachable for host-populated scopes; it guards against a forged
 * or version-skewed CLS value, never against a new host variant (the
 * projection's exhaustiveness check catches those at compile time).
 */
export class UnknownActorKindError extends Error {
  override readonly name = 'UnknownActorKindError';

  constructor(public readonly actorKind: unknown) {
    super(`Actor kind '${String(actorKind)}' has no PluginActorView projection`);
  }
}
