/**
 * A list read declaring that it genuinely has no intrinsic scope, and why.
 *
 * The reason is REQUIRED and is the whole point of the sentinel. An opt-out
 * that carries no justification is indistinguishable from a forgotten scope
 * clause, which is the failure this guard exists to make impossible — so
 * "unscoped" has to be a stated fact a reviewer can weigh, not an absence.
 *
 * Two distinct cases reach for it, and both are legitimate:
 *
 * - The envelope has no permissioned resource behind it at all. `GET /languages`
 *   serves a static i18n catalogue; there is no `ResourceType` to compose for.
 * - The resource exists and the read is deliberately install-wide.
 *
 * What it is NOT for: a read that only looks install-wide. `GET /games` returns
 * every Public game plus the caller's own private ones (#472), so its rows vary
 * by caller. Declaring such a read unscoped would state a fact that is false,
 * which is worse than leaving it undeclared.
 */
export interface UnscopedList {
  readonly kind: 'unscoped';
  readonly reason: string;
}

const MISSING_REASON =
  'Unscoped() requires a non-empty reason: an unexplained opt-out is indistinguishable from a forgotten scope clause.';

/**
 * The reason contract, enforced wherever an opt-out is built OR believed.
 *
 * `UnscopedList` is a structural type, so `{ kind: 'unscoped', reason: '' }`
 * satisfies it without ever reaching `Unscoped()`. Checking only in the factory
 * would leave the mandatory reason resting on everyone choosing the front door
 * — which is the kind of guarantee this whole seam exists to replace.
 */
function assertReason(reason: unknown): void {
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new TypeError(MISSING_REASON);
  }
}

/**
 * Declares a read intentionally unscoped. See {@link UnscopedList} for when
 * this is the honest answer and when it is cover for a defect.
 */
export function Unscoped(reason: string): UnscopedList {
  assertReason(reason);

  return Object.freeze({ kind: 'unscoped', reason: reason.trim() });
}

/**
 * Narrowing helper — an unscoped declaration, as opposed to a resource key.
 *
 * Throws on a sentinel that claims the kind and carries no reason, rather than
 * returning false. Returning false would send the literal down the scope path
 * instead: the guard would ask the registry about an object, and the composer
 * would splice `{ kind, reason }` into a where-clause and surface the mistake
 * as an unrelated Prisma error. A stated opt-out that states nothing is a
 * programmer error, and it should read as one.
 */
export function isUnscoped(scope: ListScope): scope is UnscopedList {
  if (typeof scope !== 'object' || scope === null || (scope as UnscopedList).kind !== 'unscoped') {
    return false;
  }

  assertReason((scope as UnscopedList).reason);

  return true;
}

/**
 * What a paginated list declares about its scope: either the resource type the
 * composer was asked to scope for this request, or an explicit opt-out.
 *
 * Typed as `string` rather than `ResourceType` on purpose. This lib is a leaf —
 * nothing under `@bge/shared` imports another `@bge/*` package — and pulling
 * `@bge/database` in to narrow one parameter would put the heaviest package in
 * the repo behind the most widely imported one. Call sites pass a real
 * `ResourceType` member, so the value is typed where it is written; only this
 * boundary sees it as a string.
 */
export type ListScope = string | UnscopedList;
