import { createEnv } from '@status/envirator';

export const env = createEnv({
  camelcase: true,
  productionDefaults: true,
  allowEmptyString: false,
});
