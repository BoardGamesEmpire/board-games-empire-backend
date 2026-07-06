import { SetMetadata } from '@nestjs/common';

export const NO_CACHE_KEY = 'NO_CACHE';

/**
 * Opts a route (or a whole controller) out of the global response cache.
 *
 * Use on user-scoped, mutation-adjacent surfaces where a stale read is a
 * correctness bug — e.g. a client that writes and immediately re-reads to
 * reconcile local state (offline-first sync).
 */
export const NoCache = () => SetMetadata(NO_CACHE_KEY, true);
