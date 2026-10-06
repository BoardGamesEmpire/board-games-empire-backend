import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface CoordinatorConfig {
  host: string;
  port: number;
  version: string;
}

export default registerAs('coordinator', () =>
  env.provideMany<CoordinatorConfig>([
    {
      keyTo: 'host',
      key: 'COORDINATOR_GRPC_HOST',
      defaultValue: '0.0.0.0',
    },
    {
      keyTo: 'port',
      key: 'COORDINATOR_GRPC_PORT',
      // In production every server has its own container, so each takes
      // gRPC's conventional port. In development they share a host, so each
      // has its own. The api's client defaults to the same port, and the
      // spec beside this file holds it there.
      defaultValue: 50052,
      defaultsFor: {
        production: 50051,
      },
      // As the schema reads it: parseInt would read `5e4` as 5.
      mutators: Number,
    },
    {
      keyTo: 'version',
      key: 'COORDINATOR_VERSION',
      defaultValue: '1.0.0',
    },
  ]),
);

/**
 * The address is validated here and defaulted only by the config above. The
 * bootstrap reads it from that config, and a default here would be copied
 * into the environment first and win, in production too (#626). An empty
 * value passes, since `@bge/env` reads it as unset and the config defaults it.
 */
export const coordinatorConfigValidationSchema = {
  // Takes IPv4 and IPv6 addresses too.
  COORDINATOR_GRPC_HOST: Joi.string().hostname().allow(''),
  COORDINATOR_GRPC_PORT: Joi.number().port().allow(''),
  COORDINATOR_VERSION: Joi.string().default('1.0.0'),
};
