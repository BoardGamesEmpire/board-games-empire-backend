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
      key: 'STUB_GATEWAY_GRPC_HOST',
      defaultValue: '0.0.0.0',
    },
    {
      keyTo: 'port',
      key: 'STUB_GATEWAY_GRPC_PORT',
      // As the real gateways do: gRPC's conventional port in production, where
      // each server has its own container, and a port of its own in
      // development, where they share a host.
      defaultValue: 50055,
      defaultsFor: { production: 50051 },
      // As the schema reads it: parseInt would read `5e4` as 5.
      mutators: Number,
    },
  ]),
);

/**
 * The address is validated here and defaulted only by the config above. The
 * bootstrap reads it from that config, and a default here would be copied
 * into the environment first and win (#626). An empty value passes, since
 * `@bge/env` reads it as unset and the config defaults it.
 */
export const gatewayConfigValidationSchema = {
  // Takes IPv4 and IPv6 addresses too.
  STUB_GATEWAY_GRPC_HOST: Joi.string().hostname().allow(''),
  STUB_GATEWAY_GRPC_PORT: Joi.number().port().allow(''),
};
