import { env, isTrue, splitTrimFilter } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface HealthConfig {
  httpHealthCheckUrls: string[];
  grpcHealthCheckAddress: string;
  enableHealthChecks: boolean;
}

export default registerAs('health', () =>
  env.provideMany<HealthConfig>([
    {
      keyTo: 'httpHealthCheckUrls',
      key: 'HTTP_HEALTH_CHECK_URLS',
      defaultValue: 'google|https://www.google.com,github|https://www.github.com',
      mutators: (value) => splitTrimFilter(value),
    },
    {
      keyTo: 'grpcHealthCheckAddress',
      key: 'GRPC_HEALTH_CHECK_ADDRESS',
      defaultValue: 'localhost:50051',
    },
    {
      keyTo: 'enableHealthChecks',
      key: 'ENABLE_HEALTH_CHECKS',
      defaultValue: true,
      mutators: isTrue,
    },
  ]),
);

export const healthConfigValidationSchema = {
  HTTP_HEALTH_CHECK_URLS: Joi.string().default('google|https://www.google.com,github|https://www.github.com'),
  GRPC_HEALTH_CHECK_ADDRESS: Joi.string().default('localhost:50051'),
  ENABLE_HEALTH_CHECKS: Joi.boolean().default(true),
};
