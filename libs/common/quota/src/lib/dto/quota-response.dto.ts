import type { QuotaScope } from '@bge/database';
import type { QuotaResource } from '../constants/quota-resource';

/**
 * Wire shape of a quota row. `scopeId` is `null` for a type-level default
 * (the storage sentinel is never surfaced); `limit` is a decimal string.
 */
export interface QuotaView {
  readonly createdById: string | null;
  readonly description: string | null;
  readonly enforced: boolean;
  readonly householdId: string | null;
  readonly id: string;
  readonly limit: string;
  readonly resource: QuotaResource;
  readonly scope: QuotaScope;
  readonly scopeId: string | null;
  readonly softOverage: boolean;
  readonly updatedById: string | null;
}
