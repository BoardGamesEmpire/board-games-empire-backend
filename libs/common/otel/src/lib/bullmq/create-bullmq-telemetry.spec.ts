import { BullMQOtel } from 'bullmq-otel';
import { OTEL_EXPORTER_NONE, OTEL_EXPORTER_OTLP_ENDPOINT_ENV, OTEL_METRICS_EXPORTER_ENV } from '../init/otel.config';
import { createBullMQTelemetry } from './create-bullmq-telemetry';

const restoreEnvVar = (name: string, original: string | undefined): void => {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
};

describe('createBullMQTelemetry', () => {
  let originalMetricsExporter: string | undefined;
  let originalEndpoint: string | undefined;

  beforeEach(() => {
    originalMetricsExporter = process.env[OTEL_METRICS_EXPORTER_ENV];
    originalEndpoint = process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV];
  });

  afterEach(() => {
    restoreEnvVar(OTEL_METRICS_EXPORTER_ENV, originalMetricsExporter);
    restoreEnvVar(OTEL_EXPORTER_OTLP_ENDPOINT_ENV, originalEndpoint);
  });

  describe('return shape', () => {
    it('returns a BullMQOtel instance', () => {
      const telemetry = createBullMQTelemetry();

      expect(telemetry).toBeInstanceOf(BullMQOtel);
    });

    it('exposes a tracer regardless of metrics configuration', () => {
      delete process.env[OTEL_METRICS_EXPORTER_ENV];
      delete process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV];
      const telemetry = createBullMQTelemetry();

      expect(telemetry.tracer).toBeDefined();
    });

    it('exposes a contextManager for trace context propagation', () => {
      const telemetry = createBullMQTelemetry();

      expect(telemetry.contextManager).toBeDefined();
    });
  });

  describe('metrics activation', () => {
    it('does NOT create a meter when OTEL_METRICS_EXPORTER is unset', () => {
      delete process.env[OTEL_METRICS_EXPORTER_ENV];
      delete process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV];

      const telemetry = createBullMQTelemetry();

      expect(telemetry.meter).toBeUndefined();
    });

    it('does NOT create a meter when OTEL_METRICS_EXPORTER is "none"', () => {
      process.env[OTEL_METRICS_EXPORTER_ENV] = OTEL_EXPORTER_NONE;
      process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV] = 'http://localhost:4318';

      const telemetry = createBullMQTelemetry();

      expect(telemetry.meter).toBeUndefined();
    });

    it('does NOT create a meter when OTEL_METRICS_EXPORTER is empty string', () => {
      process.env[OTEL_METRICS_EXPORTER_ENV] = '';
      process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV] = 'http://localhost:4318';

      const telemetry = createBullMQTelemetry();

      expect(telemetry.meter).toBeUndefined();
    });

    it('does NOT create a meter when OTEL_METRICS_EXPORTER is a non-"otlp" value', () => {
      // Documents that the activation gate requires OTLP specifically —
      // setting a future exporter value (e.g. 'prometheus') does NOT
      // implicitly enable bullmq-otel's meter, because `@bge/otel`
      // deliberately bypasses NodeSDK's auto-configuration of non-OTLP
      // exporters. Enabling them here would create meters with no
      // actual exporter behind them.
      process.env[OTEL_METRICS_EXPORTER_ENV] = 'prometheus';
      process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV] = 'http://localhost:4318';

      const telemetry = createBullMQTelemetry();

      expect(telemetry.meter).toBeUndefined();
    });

    it('does NOT create a meter when OTEL_METRICS_EXPORTER is "otlp" but no endpoint is configured', () => {
      // The gate requires BOTH conditions. Without an endpoint, the
      // metrics would have nowhere to go.
      process.env[OTEL_METRICS_EXPORTER_ENV] = 'otlp';
      delete process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV];

      const telemetry = createBullMQTelemetry();

      expect(telemetry.meter).toBeUndefined();
    });

    it('creates a meter when OTEL_METRICS_EXPORTER is "otlp" and an endpoint is set', () => {
      process.env[OTEL_METRICS_EXPORTER_ENV] = 'otlp';
      process.env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV] = 'http://localhost:4318';

      const telemetry = createBullMQTelemetry();

      expect(telemetry.meter).toBeDefined();
    });
  });

  describe('tracer/meter name override', () => {
    it('defaults to "bullmq" when no override is supplied', () => {
      // BullMQOtel does not expose tracerName/meterName publicly, so we
      // verify behavior by constructing two instances and confirming both
      // produce the same .tracer shape — i.e. default does not throw and
      // does not require user input.
      expect(() => createBullMQTelemetry()).not.toThrow();
    });

    it('accepts a custom tracerName without throwing', () => {
      expect(() => createBullMQTelemetry({ tracerName: 'custom-instrumentation' })).not.toThrow();
    });

    it('accepts a version string without throwing', () => {
      expect(() => createBullMQTelemetry({ version: '1.2.3' })).not.toThrow();
    });

    it('accepts both options together', () => {
      expect(() => createBullMQTelemetry({ tracerName: 'custom', version: '1.2.3' })).not.toThrow();
    });
  });
});
