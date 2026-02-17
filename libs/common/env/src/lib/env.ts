import { createEnv } from '@status/envirator';

export const env = createEnv({
  camelcase: true,
  allowEmptyString: false,
  productionDefaults: true,
});
