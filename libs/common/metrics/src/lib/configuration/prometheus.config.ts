import { env, isTrue } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface PrometheusConfig {
  defaultMetrics: {
    enabled: boolean;
    prefix: string;
    timeout: number;
  };
  collectDefaultMetrics: boolean;
}

export default registerAs('prometheus', () =>
  env.provideMany(
    [
      {
        key: 'PROMETHEUS_DEFAULT_METRICS_ENABLED',
        keyTo: 'enabled',
        defaultValue: true,
        mutators: isTrue,
      },
      {
        key: 'PROMETHEUS_DEFAULT_METRICS_PREFIX',
        keyTo: 'prefix',
        defaultValue: 'bge_',
      },
      {
        key: 'PROMETHEUS_DEFAULT_METRICS_TIMEOUT',
        keyTo: 'timeout',
        defaultValue: 5000,
        mutators: parseInt,
      },
      {
        key: 'PROMETHEUS_COLLECT_DEFAULT_METRICS',
        keyTo: 'collectDefaultMetrics',
        defaultValue: true,
        mutators: isTrue,
      },
    ],
    (record) =>
      <PrometheusConfig>{
        defaultMetrics: {
          enabled: record.enabled,
          prefix: record.prefix,
          timeout: record.timeout,
        },
        collectDefaultMetrics: record.collectDefaultMetrics,
      },
  ),
);

/**
 * For the api's root schema: `MetricsModule` loads this config with
 * `forFeature`, which validates nothing. Validation only, so the config above
 * is what defaults each variable: a schema's default is written into the
 * environment and beats the config's (#626). Each accepts `''`, which
 * `@bge/env` reads as unset.
 */
export const prometheusConfigValidationSchema = {
  PROMETHEUS_DEFAULT_METRICS_ENABLED: Joi.boolean().allow(''),
  PROMETHEUS_DEFAULT_METRICS_PREFIX: Joi.string().allow(''),
  PROMETHEUS_DEFAULT_METRICS_TIMEOUT: Joi.number().integer().positive().allow(''),
  PROMETHEUS_COLLECT_DEFAULT_METRICS: Joi.boolean().allow(''),
};
