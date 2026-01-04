import { registerAs } from '@nestjs/config';
import { env } from './env';
import { isTrue } from './helpers/helpers';

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
