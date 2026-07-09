import type { Actor } from '@bge/actor-context';

/**
 * Reason stamped on audit rows whose emission reached the listener with no
 * populated CLS actor scope. Distinct from any `SystemActorScope` reason so
 * unattributed rows never blend into genuine system activity — they indicate
 * a code-path bug (an entry point missing its actor populator) and also
 * trigger a deduped admin notification.
 */
export const UNATTRIBUTED_AUDIT_REASON = 'audit:unattributed-event';

/**
 * The fallback actor is a LABEL on the persisted row only. It is constructed
 * here inside the audit listener, never enters CLS, and is never consulted by
 * authorization — minting a real system actor into CLS remains the exclusive
 * privilege of `SystemActorScope`.
 */
export const UNATTRIBUTED_ACTOR: Actor = Object.freeze({
  kind: 'system',
  reason: UNATTRIBUTED_AUDIT_REASON,
});

/** Page size when the list query omits `limit`. */
export const AUDIT_LOG_DEFAULT_PAGE_SIZE = 50;

/** Hard page-size ceiling for the admin list endpoint. */
export const AUDIT_LOG_MAX_PAGE_SIZE = 200;
