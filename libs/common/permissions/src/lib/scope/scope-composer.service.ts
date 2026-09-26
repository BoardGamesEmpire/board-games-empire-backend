import { Action } from '@bge/database';
import { isUnscoped, type ListScope, recordComposedScope, Unscoped, type UnscopedList } from '@bge/shared';
import type { WhereInput } from '@casl/prisma';
import { Injectable } from '@nestjs/common';
import { AbilityService } from '../ability.service';
import type { ModelResourceType } from '../interfaces';

export { isUnscoped, Unscoped, type ListScope, type UnscopedList };

/**
 * Composes a collection read's own scope with the caller's permission ceiling:
 *
 * ```
 * rows = intrinsicScope AND abilityConditions
 * ```
 *
 * The distinction this exists to hold is that authorization and scope are two
 * different questions. An endpoint declares WHAT SET it is about; the caller's
 * ability decides how much of that set they may see. Before this, a list read
 * asked only the second question, so the answer set was whatever the caller's
 * permissions happened to admit — which is why the same route meant different
 * things to different callers (365).
 *
 * It deliberately does NOT live on `AbilityService`. A scope parameter on the
 * authorization service would re-merge the two concepts this separates, so the
 * dependency runs one way and only one way: the composer asks `AbilityService`
 * for a ceiling, and `AbilityService` knows nothing about scope.
 *
 * Both halves are written HERE and nowhere else. A read that names a scope and
 * quietly drops its ceiling is the inverse defect and is already in the tree —
 * `GET /webhook-subscriptions` filters by `createdById` and ANDs in no
 * conditions, which under an API-key actor returns the key owner's rows
 * regardless of the key's own scope. Routing both halves through one call makes
 * that shape unrepresentable rather than merely discouraged.
 */
@Injectable()
export class ScopeComposer {
  constructor(private readonly abilityService: AbilityService) {}

  /**
   * Builds the `where` clause for a collection read.
   *
   * `intrinsicScope` is required — that is the structural half of the guard.
   * A read with no scope of its own must say so with `Unscoped('<why>')`, which
   * costs a sentence and makes the claim reviewable; the alternative is an
   * omission indistinguishable from a forgotten clause.
   *
   * An `Unscoped` read over a real resource still comes through here, for two
   * reasons: the caller's ceiling is ANDed in all the same, and the read is
   * recorded, which is what `paginated()`'s guard checks. An envelope declaring
   * `Unscoped` itself skips that check, so it is for envelopes with no
   * `ResourceType` behind them at all. Only the ceiling comes back, so the
   * read's other filters — soft-delete, query parameters — sit beside it:
   * `{ AND: [composed, filters] }`.
   *
   * `action` is required and never defaulted, mirroring
   * `AbilityService.getCurrentResourceConditions`: defaulting to `read` reads
   * as a convenience right up until a mutation path inherits it.
   */
  compose<TResource extends ModelResourceType>(
    resourceType: TResource,
    action: Action,
    intrinsicScope: WhereInput<TResource> | UnscopedList,
  ): WhereInput<TResource> {
    const conditions = this.abilityService.getCurrentResourceConditions(resourceType, action);

    // Recorded before the return so `paginated()` can tell a composed read from
    // one that reached the database on its ceiling alone. Only `read` is
    // recorded: the guard fires when a LIST is serialized, and a write path
    // composing an update filter should not vouch for an unrelated list in the
    // same request.
    if (action === Action.read) {
      recordComposedScope(resourceType);
    }

    if (isUnscoped(intrinsicScope)) {
      return { AND: conditions } as WhereInput<TResource>;
    }

    // An intrinsic scope may carry its own `AND` — a membership clause beside a
    // soft-delete filter, say. Spreading and then assigning would drop it
    // silently and widen the read, so the two are concatenated instead.
    const { AND: scopeAnd, ...rest } = intrinsicScope as Record<string, unknown> & {
      AND?: WhereInput<TResource> | WhereInput<TResource>[];
    };

    const merged =
      scopeAnd === undefined ? conditions : [...(Array.isArray(scopeAnd) ? scopeAnd : [scopeAnd]), ...conditions];

    return { ...rest, AND: merged } as WhereInput<TResource>;
  }
}
