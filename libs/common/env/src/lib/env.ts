import { bootstrapLogging } from '@bge/logger';
import { createEnv, Environment } from '@status/envirator';

export const env = createEnv({
  camelcase: true,
  allowEmptyString: false,
  productionDefaults: true,
  logger: bootstrapLogging({
    serviceName: 'bge-env',
  }),
});

/**
 * The values `NODE_ENV` may hold: the environments `env` knows. A name outside
 * them matches no `defaultsFor` key and none of `env.isTest` and its siblings,
 * so every per-environment default silently misses (#290).
 */
export const environments: readonly string[] = Object.values(Environment);
