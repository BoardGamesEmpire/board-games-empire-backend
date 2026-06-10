import { metricsExportEnabled, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT_ENV } from './metrics-enabled';
import { OTEL_EXPORTER_OTLP_ENDPOINT_ENV, OTEL_METRICS_EXPORTER_ENV } from './otel.config';

describe('metricsExportEnabled', () => {
  describe('exporter opt-in', () => {
    it('returns false when OTEL_METRICS_EXPORTER is unset', () => {
      const env: NodeJS.ProcessEnv = {};

      expect(metricsExportEnabled(env)).toBe(false);
    });

    it('returns false when OTEL_METRICS_EXPORTER is "none", even with an endpoint set', () => {
      const env: NodeJS.ProcessEnv = {
        [OTEL_METRICS_EXPORTER_ENV]: 'none',
        [OTEL_EXPORTER_OTLP_ENDPOINT_ENV]: 'http://localhost:4318',
      };

      expect(metricsExportEnabled(env)).toBe(false);
    });

    it('returns false for non-"otlp" exporter values, even with an endpoint set', () => {
      // Documents the contract: bullmq-otel and the recorder are wired
      // for OTLP only; setting a future value like 'prometheus' must
      // NOT silently enable them.
      const env: NodeJS.ProcessEnv = {
        [OTEL_METRICS_EXPORTER_ENV]: 'prometheus',
        [OTEL_EXPORTER_OTLP_ENDPOINT_ENV]: 'http://localhost:4318',
      };

      expect(metricsExportEnabled(env)).toBe(false);
    });
  });

  describe('endpoint requirement', () => {
    it('returns false when OTEL_METRICS_EXPORTER is "otlp" but no endpoint is configured', () => {
      const env: NodeJS.ProcessEnv = {
        [OTEL_METRICS_EXPORTER_ENV]: 'otlp',
      };

      expect(metricsExportEnabled(env)).toBe(false);
    });

    it('returns false when OTEL_EXPORTER_OTLP_ENDPOINT is an empty string', () => {
      const env: NodeJS.ProcessEnv = {
        [OTEL_METRICS_EXPORTER_ENV]: 'otlp',
        [OTEL_EXPORTER_OTLP_ENDPOINT_ENV]: '',
      };

      expect(metricsExportEnabled(env)).toBe(false);
    });

    it('returns true when OTEL_METRICS_EXPORTER is "otlp" and OTEL_EXPORTER_OTLP_ENDPOINT is set', () => {
      const env: NodeJS.ProcessEnv = {
        [OTEL_METRICS_EXPORTER_ENV]: 'otlp',
        [OTEL_EXPORTER_OTLP_ENDPOINT_ENV]: 'http://localhost:4318',
      };

      expect(metricsExportEnabled(env)).toBe(true);
    });

    it('returns true when only the per-signal OTEL_EXPORTER_OTLP_METRICS_ENDPOINT is set', () => {
      const env: NodeJS.ProcessEnv = {
        [OTEL_METRICS_EXPORTER_ENV]: 'otlp',
        [OTEL_EXPORTER_OTLP_METRICS_ENDPOINT_ENV]: 'http://metrics.example/v1/metrics',
      };

      expect(metricsExportEnabled(env)).toBe(true);
    });

    it('returns true when both endpoints are set', () => {
      const env: NodeJS.ProcessEnv = {
        [OTEL_METRICS_EXPORTER_ENV]: 'otlp',
        [OTEL_EXPORTER_OTLP_ENDPOINT_ENV]: 'http://localhost:4318',
        [OTEL_EXPORTER_OTLP_METRICS_ENDPOINT_ENV]: 'http://metrics.example/v1/metrics',
      };

      expect(metricsExportEnabled(env)).toBe(true);
    });
  });

  describe('default to process.env', () => {
    it('reads from process.env when no argument is given', () => {
      const originalExporter = process.env[OTEL_METRICS_EXPORTER_ENV];
      const originalEndpoint = process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV];

      delete process.env[OTEL_METRICS_EXPORTER_ENV];
      delete process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV];

      try {
        expect(metricsExportEnabled()).toBe(false);
      } finally {
        if (originalExporter === undefined) {
          delete process.env[OTEL_METRICS_EXPORTER_ENV];
        } else {
          process.env[OTEL_METRICS_EXPORTER_ENV] = originalExporter;
        }
        if (originalEndpoint === undefined) {
          delete process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV];
        } else {
          process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV] = originalEndpoint;
        }
      }
    });
  });
});
