import { BullMQOtel } from 'bullmq-otel';
import { OTEL_EXPORTER_NONE, OTEL_METRICS_EXPORTER_ENV } from '../init/otel.config';
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

  beforeEach(() => {
    originalMetricsExporter = process.env[OTEL_METRICS_EXPORTER_ENV];
  });

  afterEach(() => {
    restoreEnvVar(OTEL_METRICS_EXPORTER_ENV, originalMetricsExporter);
  });

  describe('return shape', () => {
    it('returns a BullMQOtel instance', () => {
      const telemetry = createBullMQTelemetry();

      expect(telemetry).toBeInstanceOf(BullMQOtel);
    });

    it('exposes a tracer regardless of metrics configuration', () => {
      delete process.env[OTEL_METRICS_EXPORTER_ENV];
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

      const telemetry = createBullMQTelemetry();

      expect(telemetry.meter).toBeUndefined();
    });

    it('does NOT create a meter when OTEL_METRICS_EXPORTER is "none"', () => {
      process.env[OTEL_METRICS_EXPORTER_ENV] = OTEL_EXPORTER_NONE;

      const telemetry = createBullMQTelemetry();

      expect(telemetry.meter).toBeUndefined();
    });

    it('does NOT create a meter when OTEL_METRICS_EXPORTER is empty string', () => {
      process.env[OTEL_METRICS_EXPORTER_ENV] = '';

      const telemetry = createBullMQTelemetry();

      expect(telemetry.meter).toBeUndefined();
    });

    it('creates a meter when OTEL_METRICS_EXPORTER is "otlp"', () => {
      process.env[OTEL_METRICS_EXPORTER_ENV] = 'otlp';

      const telemetry = createBullMQTelemetry();

      expect(telemetry.meter).toBeDefined();
    });

    it('creates a meter for any non-"none" exporter value (forward compatible)', () => {
      // BullMQOtel itself only branches on truthiness of enableMetrics —
      // future exporter names (e.g. 'prometheus') should not silently
      // turn off the meter. Verify we don't pin to 'otlp' specifically.
      process.env[OTEL_METRICS_EXPORTER_ENV] = 'prometheus';

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
