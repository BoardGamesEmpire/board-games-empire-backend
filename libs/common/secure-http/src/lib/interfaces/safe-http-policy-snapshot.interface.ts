/**
 * Immutable snapshot of the admin-controlled `SafeHttpPolicy` singleton row,
 * consumed by `IpPolicyService.evaluate` and `SafeHttpService.request`. The
 * `SafeHttpPolicyService` (Pass 4) holds the current snapshot in memory and
 * swaps it atomically on hot-reload — readers either see the old snapshot
 * or the new, never a half-updated mix.
 *
 * Distinct from the Prisma `SafeHttpPolicy` model type: this interface
 * excludes admin metadata (id, identifier, timestamps, updatedBy) and
 * collapses host/CIDR string columns into `readonly` arrays so the
 * evaluator can't mutate them.
 */
export interface SafeHttpPolicySnapshot {
  defaultTimeoutMs: number;
  defaultMaxRedirects: number;
  strictMode: boolean;
  readonly allowedHosts: readonly string[];
  readonly allowedCidrs: readonly string[];
  readonly blockedHosts: readonly string[];
  readonly blockedCidrs: readonly string[];
}
