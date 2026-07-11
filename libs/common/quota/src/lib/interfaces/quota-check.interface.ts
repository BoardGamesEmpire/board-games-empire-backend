import type { QuotaScope } from '@bge/database';
import type { QuotaSoftOverageEvent } from './quota-events.interface';

/**
 * Scope targets a `check()` should consider beyond the ambient ones.
 *
 * The `User` scope is taken from actor-context/CLS (the acting user) and
 * `Server` is implicit, so neither appears here. Supply `householdId` /
 * `householdMemberId` when the write is attributed to a household or a specific
 * membership. A scope the resource declares applicable but whose id is absent
 * here is simply not evaluated.
 */
export interface QuotaCheckContext {
  readonly userId: string;
  readonly householdId?: string;
  readonly householdMemberId?: string;
}

/**
 * One scope's contribution to a check. `scopeId` is the concrete target the
 * limit resolved against. `exceeded` is `usage + amount > limit`.
 */
export interface QuotaConstraint {
  readonly scope: QuotaScope;
  readonly scopeId: string;
  readonly limit: bigint;
  readonly currentUsage: bigint;
  readonly softOverage: boolean;
  readonly exceeded: boolean;
}

/**
 * Outcome of a check. `allowed` is false only when a *hard* constraint is
 * exceeded. `scope`/`limit`/`currentUsage`/`softOverage` describe the *binding*
 * constraint (the exceeded hard one with least headroom, else the tightest
 * constraint overall); they are null when no quota applied. `constraints` is
 * the full per-scope breakdown for callers that want it.
 *
 * `softOverages` are the ready-to-emit warnings for every soft cap this call
 * crossed. `check()` emits them eagerly (read path — nothing to roll back) and
 * still returns them for observability. `consume()` does NOT emit them: it runs
 * inside the caller's transaction, so emitting there would fire for a write
 * that may still roll back. A `consume()` caller must forward these to
 * `QuotaService.emitSoftOverages(...)` AFTER its transaction commits.
 */
export interface QuotaCheckResult {
  readonly allowed: boolean;
  readonly scope: QuotaScope | null;
  readonly currentUsage: bigint | null;
  readonly limit: bigint | null;
  readonly softOverage: boolean;
  readonly constraints: readonly QuotaConstraint[];
  readonly softOverages: readonly QuotaSoftOverageEvent[];
}
