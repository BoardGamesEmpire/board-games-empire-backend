import { wasScopeComposed } from './composed-scope-registry.js';
import { isUnscoped, type ListScope } from './list-scope.js';
import { PENDING_SCOPE_SWEEP } from './pending-scope-sweep.js';
import { ListScopeNotComposedError } from './unscoped-list.error.js';

/**
 * Asserts that the list about to be serialized had an intrinsic scope composed
 * for it, or says out loud that it has none.
 *
 * Keyed by resource type rather than set as a per-request flag, so a handler
 * building envelopes for two different resources has to satisfy the guard for
 * each of them. A single flag would let one scoped list vouch for every other
 * list in the request, which is the failure mode worth designing out.
 *
 * Known limit: two envelopes of the SAME resource in one request satisfy each
 * other. Closing that needs a per-call receipt threaded from the read to the
 * controller, which costs a signature change at every list and buys little —
 * a handler serving the same resource twice is not a shape that occurs here.
 *
 * @throws ListScopeNotComposedError when a scope was declared and never composed.
 */
export function assertListScopeComposed(resourceKey: string, scope: ListScope): void {
  if (isUnscoped(scope)) {
    return;
  }

  if (wasScopeComposed(scope)) {
    return;
  }

  // Not yet swept onto the invariant. Pinned, enumerated and shrinking — see
  // PENDING_SCOPE_SWEEP for why the guard ships live rather than inert.
  if (PENDING_SCOPE_SWEEP.has(scope)) {
    return;
  }

  throw new ListScopeNotComposedError(resourceKey, scope);
}
