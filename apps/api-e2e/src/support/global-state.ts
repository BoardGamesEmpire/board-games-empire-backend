import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { ChildProcess } from 'node:child_process';

/**
 * Handles started by `global-setup` and stopped by `global-teardown`:
 * the two dependency containers and the API server child process. Jest
 * runs both files in the SAME main process (test files run in workers),
 * so `globalThis` is the documented channel between them. A container
 * handle is absent when the corresponding escape hatch
 * (`BGE_E2E_DATABASE_URL` / `BGE_E2E_REDIS_URL`) is in use.
 */
export interface E2EGlobalState {
  readonly postgres?: StartedPostgreSqlContainer;
  readonly redis?: StartedRedisContainer;
  readonly api?: ChildProcess;
}

interface E2EGlobalCarrier {
  __BGE_E2E_STATE__?: E2EGlobalState;
}

const carrier = globalThis as unknown as E2EGlobalCarrier;

export function setE2EGlobalState(state: E2EGlobalState): void {
  carrier.__BGE_E2E_STATE__ = state;
}

export function getE2EGlobalState(): E2EGlobalState {
  return carrier.__BGE_E2E_STATE__ ?? {};
}
