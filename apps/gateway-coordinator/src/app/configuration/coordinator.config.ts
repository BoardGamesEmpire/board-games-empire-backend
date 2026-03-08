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
      defaultValue: 50052,
      defaultsFor: {
        production: 50051,
      },
      mutators: parseInt,
    },
    {
      keyTo: 'version',
      key: 'COORDINATOR_VERSION',
      defaultValue: '1.0.0',
    },
  ]),
);

export const coordinatorConfigValidationSchema = {
  COORDINATOR_GRPC_HOST: Joi.string().hostname().default('0.0.0.0'),
  COORDINATOR_GRPC_PORT: Joi.number().default(50052),
  COORDINATOR_VERSION: Joi.string().default('1.0.0'),
};
