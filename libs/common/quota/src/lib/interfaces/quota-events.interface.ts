import type { QuotaScope } from '@bge/database';
import type { QuotaResource } from '../constants/quota-resource';

/**
 * Emitted when an admin sets/changes a cap. `scopeId` is `null` for a
 * type-level default (the sentinel is a storage detail, never surfaced).
 * `limit` is a decimal string — bigint does not survive JSON/structured
 * cloning across the listener boundary.
 */
export interface QuotaUpdatedEvent {
  readonly scope: QuotaScope;
  readonly scopeId: string | null;
  readonly householdId: string | null;
  readonly resource: QuotaResource;
  readonly limit: string;
  readonly softOverage: boolean;
  readonly enforced: boolean;
}

/**
 * Emitted on every `check()` that crosses a soft limit (warn-every). All
 * bigints are decimal strings for the same reason as above. `scopeId` is `null`
 * for a type-level/Server default — the storage sentinel is never surfaced,
 * matching `QuotaUpdatedEvent`.
 */
export interface QuotaSoftOverageEvent {
  readonly scope: QuotaScope;
  readonly scopeId: string | null;
  readonly resource: QuotaResource;
  readonly currentUsage: string;
  readonly attemptedAmount: string;
  readonly limit: string;
}
