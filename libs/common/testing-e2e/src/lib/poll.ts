import { setTimeout as sleep } from 'node:timers/promises';

export interface PollOptions {
  /** What is being awaited — appears verbatim in the timeout error. */
  readonly description: string;

  /** Total budget before failing. Default {@link DEFAULT_POLL_TIMEOUT_MS}. */
  readonly timeoutMs?: number;

  /** Pause between retries. Default {@link DEFAULT_POLL_INTERVAL_MS}. */
  readonly intervalMs?: number;
}

export const DEFAULT_POLL_TIMEOUT_MS = 15_000;
export const DEFAULT_POLL_INTERVAL_MS = 100;

/**
 * Repeatedly invokes `probe` until it resolves to a defined value, the
 * standard shape for waiting out the asynchronous provisioning window
 * (#256): the signup response can return before the `@OnEvent` provisioning
 * handler commits, so factories poll for the rows it creates rather than
 * assuming they exist.
 *
 * The first probe runs immediately (the common case is that provisioning
 * already finished); the interval only paces retries. Probe REJECTIONS are
 * not retried — an error from the probe is a real failure and propagates
 * immediately, fail-loud.
 *
 * `undefined` is the "not yet" sentinel, so a probe whose legitimate result
 * could be `undefined` must wrap it; in practice every caller here probes
 * for a row and maps absence to `undefined`.
 */
export async function pollUntil<T>(probe: () => Promise<T | undefined>, options: PollOptions): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const result = await probe();

    if (result !== undefined) {
      return result;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${options.description}`);
    }

    await sleep(intervalMs);
  }
}
