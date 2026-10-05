import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface CoordinatorClientConfig {
  host: string;
  port: number;
}

export default registerAs('coordinatorClient', () =>
  env.provideMany<CoordinatorClientConfig>([
    {
      keyTo: 'host',
      key: 'GATEWAY_COORDINATOR_HOST',
      // A coordinator on this machine. One in a container of its own needs
      // this set to that container's address.
      defaultValue: 'localhost',
    },
    {
      keyTo: 'port',
      key: 'GATEWAY_COORDINATOR_PORT',
      // The coordinator's own default, which a spec in the coordinator app
      // holds this to.
      defaultValue: 50052,
      defaultsFor: {
        production: 50051,
      },
      // As the schema reads it: parseInt would read `5e4` as 5.
      mutators: Number,
    },
  ]),
);

/**
 * For the root schema of an app that loads this client: the module loads its
 * config with `forFeature`, which validates nothing. Validation only, so the
 * config above is what defaults the address (#626). An empty value passes,
 * since `@bge/env` reads it as unset and the config defaults it.
 */
export const coordinatorClientConfigValidationSchema = {
  // Takes IPv4 and IPv6 addresses too.
  GATEWAY_COORDINATOR_HOST: Joi.string().hostname().allow(''),
  GATEWAY_COORDINATOR_PORT: Joi.number().port().allow(''),
};
