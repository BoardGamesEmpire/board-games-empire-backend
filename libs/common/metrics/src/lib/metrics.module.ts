import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import prometheusConfig from './configuration/prometheus.config';
import { MetricsController } from './metrics.controller';

@Module({
  imports: [
    ConfigModule.forFeature(prometheusConfig),
    PrometheusModule.registerAsync({
      inject: [ConfigService],
      controller: MetricsController,
      useFactory: (config: ConfigService) => ({
        defaultMetrics: {
          enabled: config.getOrThrow<boolean>('prometheus.defaultMetrics.enabled'),
          config: {
            prefix: config.get<string>('prometheus.defaultMetrics.prefix'),
            timeout: config.get<number>('prometheus.defaultMetrics.timeout'),
          },
        },
        defaultLabels: { app: 'BoardGamesEmpire' },
      }),
    }),
  ],
  providers: [],
  exports: [],
})
export class MetricsModule {}
