import type { DatabaseService, Prisma, QuotaScope } from '@bge/database';
import type { QuotaResource } from '../constants/quota-resource';

/**
 * Either the root client or an interactive-transaction client. Usage providers
 * accept one so `consume()` can re-measure under an advisory lock inside the
 * caller's transaction; `check()` passes the root client.
 */
export type QuotaExecutor = DatabaseService | Prisma.TransactionClient;

/**
 * Computes current usage of a resource for one resolved scope target.
 *
 * `scopeId` is the resolved target for `scope`: a concrete instance id for
 * User/Household/HouseholdMember, and the default sentinel ('*') for Server,
 * whose usage is the global aggregate — ignore `scopeId` in that branch.
 * Returns a non-negative bigint. Implementations branch on `scope` when a
 * resource is measured in more than one scope (e.g. storage at Server + User).
 */
export type QuotaUsageProvider = (scope: QuotaScope, scopeId: string, db?: QuotaExecutor) => Promise<bigint>;

/**
 * Code-defined description of a quota-eligible resource.
 *
 * `applicableScopes` declares which scopes this resource is *measured* in —
 * the resolver evaluates a check against exactly these (intersected with the
 * scope ids available in the check context).
 *
 * `usage` is omitted for resources that are registered but not yet enforceable
 * (the underlying model doesn't exist yet). `check()` against such a resource
 * throws, rather than silently passing.
 */
export interface QuotaResourceDefinition {
  readonly key: QuotaResource;
  readonly applicableScopes: readonly QuotaScope[];
  readonly usage?: QuotaUsageProvider;
}
