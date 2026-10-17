import { MissingEnvironmentError } from '@status/envirator';

/**
 * Calls `run` with `variables` as the whole environment, then restores the
 * process's own. A config factory called this way sees what Nest would hand it
 * at boot, and nothing from the shell or a `.env`.
 */
export function withEnvironment<T>(variables: Record<string, string>, run: () => T): T {
  const saved = process.env;
  process.env = { ...variables };

  try {
    return run();
  } finally {
    process.env = saved;
  }
}

/** {@link withEnvironment}, for work that awaits: the process's environment is restored once it settles. */
export async function withEnvironmentAsync<T>(variables: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = process.env;
  process.env = { ...variables };

  try {
    return await run();
  } finally {
    process.env = saved;
  }
}

/**
 * Calls a config factory with `variables` as the whole environment and returns
 * the variables it reports missing: none when it resolves.
 */
export function missingVariables(factory: () => unknown, variables: Record<string, string>): readonly string[] {
  return withEnvironment(variables, () => missingFrom(factory));
}

/** Calls a config factory against the environment as it is, and returns the variables it reports missing. */
export function missingFrom(factory: () => unknown): readonly string[] {
  try {
    factory();
    return [];
  } catch (error) {
    if (error instanceof MissingEnvironmentError) {
      return error.keys;
    }

    throw error;
  }
}
