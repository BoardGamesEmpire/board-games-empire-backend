import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ChildProcess } from 'node:child_process';
import type { FakeSignInProvider } from './fake-sign-in-provider';
import type { StartedMailpit } from './mailpit';
import type { StartedRedisServer } from './redis-server';

/**
 * Handles started by `global-setup` and stopped by `global-teardown`:
 * the two dependency containers, the Mailpit container outgoing mail reaches
 * (#654), the API server child process and the fake sign-in provider it signs
 * users in through (#912). Jest runs both files
 * in the SAME main process (test files run in workers), so `globalThis` is
 * the documented channel between them. A container handle is absent when
 * the corresponding escape hatch (`BGE_E2E_DATABASE_URL` /
 * `BGE_E2E_REDIS_URL`) is in use.
 */
export interface E2EGlobalState {
  readonly api?: ChildProcess;
  readonly mailpit?: StartedMailpit;
  /** The plugins root the API was given (#1094), which teardown removes. */
  readonly pluginsRoot?: string;
  readonly postgres?: StartedPostgreSqlContainer;
  readonly redis?: StartedRedisServer;
  readonly signInProvider?: FakeSignInProvider;
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
