import type { QuotaScope } from '@bge/database';
import type { QuotaResource } from '../constants/quota-resource';

/**
 * Emitted when an admin sets/changes a cap. `scopeId` is `null` for a
 * type-level default (the sentinel is a storage detail, never surfaced).
 * `limit` is a decimal string — bigint does not survive JSON/structured
 * cloning across the listener boundary.
 */
export interface QuotaUpdatedEvent {
  readonly enforced: boolean;
  readonly householdId: string | null;
  readonly limit: string;
  readonly resource: QuotaResource;
  readonly scope: QuotaScope;
  readonly scopeId: string | null;
  readonly softOverage: boolean;
}

/**
 * Emitted on every `check()` that crosses a soft limit (warn-every). All
 * bigints are decimal strings for the same reason as above. `scopeId` is `null`
 * for a type-level/Server default — the storage sentinel is never surfaced,
 * matching `QuotaUpdatedEvent`.
 */
export interface QuotaSoftOverageEvent {
  readonly attemptedAmount: string;
  readonly currentUsage: string;
  readonly limit: string;
  readonly resource: QuotaResource;
  readonly scope: QuotaScope;
  readonly scopeId: string | null;
}
