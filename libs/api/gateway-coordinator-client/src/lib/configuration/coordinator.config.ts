import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface CoordinatorConfig {
  host: string;
  port: number;
}

export default registerAs('coordinatorClient', () =>
  env.provideMany<CoordinatorConfig>([
    {
      keyTo: 'host',
      key: 'GATEWAY_COORDINATOR_HOST',
      defaultValue: '0.0.0.0',
    },
    {
      keyTo: 'port',
      key: 'GATEWAY_COORDINATOR_PORT',
      defaultValue: 50052,
      defaultsFor: {
        production: 50051,
      },
      mutators: parseInt,
    },
  ]),
);

export const coordinatorConfigValidationSchema = {
  GATEWAY_COORDINATOR_HOST: Joi.string().hostname().default('0.0.0.0'),
  GATEWAY_COORDINATOR_PORT: Joi.number().default(50052),
};
