import type { Quota } from '@bge/database';
import { DEFAULT_SCOPE_ID, type QuotaResource } from './constants/quota-resource';
import type { QuotaView } from './dto/quota-response.dto';

/**
 * Storage sentinel → public `null` (a type-level default has no instance id).
 */
export function toPublicScopeId(scopeId: string): string | null {
  return scopeId === DEFAULT_SCOPE_ID ? null : scopeId;
}

/**
 * Public `null`/absent → storage sentinel.
 */
export function toStorageScopeId(scopeId: string | null | undefined): string {
  return scopeId == null ? DEFAULT_SCOPE_ID : scopeId;
}

/**
 * DB row → wire view: bigint `limit` as string, sentinel `scopeId` as null.
 */
export function toQuotaView(quota: Quota): QuotaView {
  return {
    id: quota.id,
    scope: quota.scope,
    scopeId: toPublicScopeId(quota.scopeId),
    householdId: quota.householdId,
    resource: quota.resource as QuotaResource,
    limit: quota.limit.toString(),
    softOverage: quota.softOverage,
    enforced: quota.enforced,
    description: quota.description,
    createdById: quota.createdById,
    updatedById: quota.updatedById,
  };
}
