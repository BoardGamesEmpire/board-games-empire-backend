import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';

/**
 * The containers `global-setup` starts and `global-teardown` stops. Jest runs
 * both files in its main process (spec files run in workers), so `globalThis`
 * is the documented channel between them.
 */
export interface E2EGlobalState {
  readonly postgres?: StartedPostgreSqlContainer;
  readonly redis?: StartedRedisContainer;
}

interface E2EGlobalCarrier {
  __BGE_COORDINATOR_E2E_STATE__?: E2EGlobalState;
}

const carrier = globalThis as unknown as E2EGlobalCarrier;

export function setE2EGlobalState(state: E2EGlobalState): void {
  carrier.__BGE_COORDINATOR_E2E_STATE__ = state;
}

export function getE2EGlobalState(): E2EGlobalState {
  return carrier.__BGE_COORDINATOR_E2E_STATE__ ?? {};
}
