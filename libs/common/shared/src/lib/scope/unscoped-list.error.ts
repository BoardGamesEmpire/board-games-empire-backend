import { InternalServerErrorException } from '@nestjs/common';

/**
 * Raised when a paginated list is built for a resource whose intrinsic scope
 * was never composed for this request — i.e. the read took the caller's
 * permission ceiling as its answer set, which is the defect 365 exists to
 * remove.
 *
 * A programmer error (500), explicitly NOT an authorization failure (403).
 * Modelled on `AbilityContextNotPrimedError`: a request reached a query
 * without the context that query requires, and the honest response is that
 * the server is misconfigured rather than that the caller lacked access.
 *
 * Deliberately thrown in EVERY environment, production included. A guardrail
 * disabled where it matters is not a guardrail, and splitting behaviour by
 * environment means the failure first appears in the one place nobody can
 * attach a debugger to.
 */
export class ListScopeNotComposedError extends InternalServerErrorException {
  constructor(resourceKey: string, scope: string) {
    super(
      `The '${resourceKey}' list was built without composing an intrinsic scope for '${scope}'. ` +
        'A collection read must ask ScopeComposer.compose() for its where-clause so the rows are ' +
        "scoped by the endpoint and merely clipped by the caller's ability, rather than being " +
        "whatever that caller's permissions happen to admit. If this list genuinely has no scope " +
        "of its own, say so explicitly with Unscoped('<why>') instead of leaving it undeclared.",
    );
  }
}
