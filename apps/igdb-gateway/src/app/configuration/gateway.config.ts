import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface GatewayConfig {
  host: string;
  port: number;
}

const GRPC_HOST = '0.0.0.0';

/**
 * In production every server has its own container, so each takes gRPC's
 * conventional port. In development they share a host, so each has its own.
 */
const GRPC_PORT = { defaultValue: 50054, defaultsFor: { production: 50051 } };

export default registerAs('gateway', () =>
  env.provideMany<GatewayConfig>([
    {
      keyTo: 'host',
      key: 'IGDB_GATEWAY_GRPC_HOST',
      defaultValue: GRPC_HOST,
    },
    {
      keyTo: 'port',
      key: 'IGDB_GATEWAY_GRPC_PORT',
      ...GRPC_PORT,
      mutators: parseInt,
    },
  ]),
);

/**
 * The bootstrap reads the gateway's address from process.env, and only this
 * schema fills it: ConfigModule copies each validated value, defaults
 * included, into an unset variable. So these defaults are the address the
 * gateway listens on, and they follow NODE_ENV as the config's do.
 */
export const gatewayConfigValidationSchema = {
  IGDB_GATEWAY_GRPC_HOST: Joi.alternatives()
    .try(Joi.string().hostname(), Joi.string().ip({ version: ['ipv4', 'ipv6'] }))
    .default(GRPC_HOST),
  IGDB_GATEWAY_GRPC_PORT: Joi.number().when('NODE_ENV', {
    is: Joi.string().valid('production').insensitive().required(),
    then: Joi.number().default(GRPC_PORT.defaultsFor.production),
    otherwise: Joi.number().default(GRPC_PORT.defaultValue),
  }),
};
