import { ClsServiceManager } from 'nestjs-cls';

/**
 * CLS slot holding the resource types whose intrinsic scope the composer has
 * built during the current request.
 *
 * Namespaced like the other CLS keys (`actor-context:*`, `permissions:*`) and
 * deliberately not exported from the barrel: the only sanctioned writer is
 * `ScopeComposer`, and the only reader is `paginated()`. Keeping the key
 * private stops a caller satisfying the guard by writing the slot instead of
 * composing a scope, which would turn the assertion into decoration.
 */
const COMPOSED_SCOPES_CLS_KEY = 'permissions:composedScopes' as const;

/**
 * Reaches the singleton `ClsService` outside DI, or `null` when CLS is not
 * running.
 *
 * `paginated()` is a free function called from controllers, so it cannot
 * inject anything — the same constraint `getActorSnapshotFromCls` solves this
 * way in `@bge/actor-context`.
 */
function activeCls() {
  try {
    const cls = ClsServiceManager.getClsService();
    return cls.isActive() ? cls : null;
  } catch {
    // CLS not initialized at all (pre-bootstrap, a bare unit test). Not a
    // request, so there is no scope obligation to enforce.
    return null;
  }
}

/**
 * Records that an intrinsic scope was composed for `resourceType` in this
 * request. Called by `ScopeComposer` and nothing else.
 *
 * A Set rather than a boolean, because the guard has to survive a handler that
 * serves lists of two different resources: scoping one must not vouch for the
 * other. That is the precise failure a single "did I compose?" flag waves
 * through. Membership is by resource type, so repeated reads of the SAME
 * resource are indistinguishable — see `assertListScopeComposed` for why that
 * limit is accepted.
 *
 * A no-op outside a request scope. The composer cannot run without primed
 * abilities anyway, so there is no path where this silently drops a record
 * that mattered.
 */
export function recordComposedScope(resourceType: string): void {
  const cls = activeCls();

  if (!cls) {
    return;
  }

  const composed = cls.get<Set<string> | undefined>(COMPOSED_SCOPES_CLS_KEY);

  if (composed) {
    composed.add(resourceType);
    return;
  }

  cls.set(COMPOSED_SCOPES_CLS_KEY, new Set([resourceType]));
}

/**
 * Whether an intrinsic scope was composed for `resourceType` in this request.
 *
 * Returns `true` when CLS is not active: outside a request there is no ability
 * context either, so nothing could have composed and nothing is being guarded.
 * Failing loud there would break every unit test that builds an envelope
 * directly, without catching a single real unscoped read — the reads this
 * guard is aimed at all run inside a request.
 */
export function wasScopeComposed(resourceType: string): boolean {
  const cls = activeCls();

  if (!cls) {
    return true;
  }

  return cls.get<Set<string> | undefined>(COMPOSED_SCOPES_CLS_KEY)?.has(resourceType) ?? false;
}
