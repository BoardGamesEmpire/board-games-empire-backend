import { diag } from '@opentelemetry/api';

/**
 * The longest delay Node's timers honour. `setTimeout` and `setInterval`
 * treat anything below 1 or above this as 1 ms, so an out-of-range
 * interval would fire every millisecond (#1436).
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Reads one of the spec's numeric SDK variables that must be greater than 0.
 * Unset and blank values yield `undefined` quietly, so the caller keeps its
 * default. A value that is set but unusable (non-numeric, infinite, 0 or
 * below) also yields `undefined`, and is reported through `diag`, as
 * NodeSDK reports its own.
 */
export const positiveNumberFromEnv = (env: NodeJS.ProcessEnv, name: string): number | undefined =>
  numberFromEnv(env, name, (value) => value > 0, 'a number greater than 0');

/**
 * Reads a variable holding a delay in milliseconds that is handed to a Node
 * timer. Like {@link positiveNumberFromEnv}, but a value outside 1 to
 * {@link MAX_TIMER_DELAY_MS} is also rejected with a `diag` warning: Node
 * would run such a timer every millisecond rather than at the delay set.
 */
export const timerDelayFromEnv = (env: NodeJS.ProcessEnv, name: string): number | undefined =>
  numberFromEnv(
    env,
    name,
    (value) => value >= 1 && value <= MAX_TIMER_DELAY_MS,
    `a number of milliseconds from 1 to ${MAX_TIMER_DELAY_MS}`,
  );

/**
 * Parses with `Number`, as the SDK's `getNumberFromEnv` does, rather than
 * `parseInt`: `10000ms` is rejected instead of read as `10000`, and `5.5`
 * is kept whole instead of truncated to `5`.
 */
const numberFromEnv = (
  env: NodeJS.ProcessEnv,
  name: string,
  accepts: (value: number) => boolean,
  expected: string,
): number | undefined => {
  const raw = env[name]?.trim();
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || !accepts(value)) {
    diag.warn(`${name} (${raw}) is invalid, expected ${expected}; using the default.`);
    return undefined;
  }

  return value;
};
