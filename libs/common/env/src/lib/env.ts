import { bootstrapLogging } from '@bge/logger';
import { createEnv } from '@status/envirator';

export const env = createEnv({
  camelcase: true,
  allowEmptyString: false,
  productionDefaults: true,
  logger: bootstrapLogging({
    serviceName: 'bge-env',
  }),
});
