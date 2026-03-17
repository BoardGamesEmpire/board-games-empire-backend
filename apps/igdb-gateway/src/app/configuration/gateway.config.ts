import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface GatewayConfig {
  host: string;
  port: number;
}

export default registerAs('gateway', () =>
  env.provideMany<GatewayConfig>([
    {
      keyTo: 'host',
      key: 'IGDB_GATEWAY_GRPC_HOST',
      defaultValue: '0.0.0.0',
    },
    {
      keyTo: 'port',
      key: 'IGDB_GATEWAY_GRPC_PORT',
      defaultValue: 50054,
      defaultsFor: {
        production: 50051,
      },
      mutators: parseInt,
    },
  ]),
);

export const gatewayConfigValidationSchema = {
  IGDB_GATEWAY_GRPC_HOST: Joi.alternatives()
    .try(Joi.string().hostname(), Joi.string().ip({ version: ['ipv4', 'ipv6'] }))
    .default('0.0.0.0'),
  IGDB_GATEWAY_GRPC_PORT: Joi.number().default(50054),
};
