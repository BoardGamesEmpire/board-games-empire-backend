/**
 * Quota domain event names, emitted on EventEmitter2.
 *
 * `quota.updated.v1` is auditable (admin mutation of a cap). `quota.soft_overage.v1`
 * fires on every `check()` that crosses a soft limit (warn-every) — noisy by
 * design, opt it out of audit persistence if/when these become MutationEvents
 * under the #57 audit migration.
 */
export const QuotaEvents = {
  Updated: 'quota.updated.v1',
  SoftOverage: 'quota.soft_overage.v1',
} as const;

export type QuotaEventName = (typeof QuotaEvents)[keyof typeof QuotaEvents];
