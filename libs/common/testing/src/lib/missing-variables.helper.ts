import { MissingEnvironmentError } from '@status/envirator';

/**
 * Calls a config factory with `variables` as the whole environment, as Nest
 * calls it at boot, and returns the variables it reports missing: none when it
 * resolves. The process's own environment is restored afterwards.
 */
export function missingVariables(factory: () => unknown, variables: Record<string, string>): readonly string[] {
  const saved = process.env;
  process.env = { ...variables };

  try {
    factory();
    return [];
  } catch (error) {
    if (error instanceof MissingEnvironmentError) {
      return error.keys;
    }

    throw error;
  } finally {
    process.env = saved;
  }
}
