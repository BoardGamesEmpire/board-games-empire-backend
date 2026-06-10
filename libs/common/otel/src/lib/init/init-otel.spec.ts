import type { MetricReader } from '@opentelemetry/sdk-metrics';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

// jest.mock factories run before imports; the order of jest.mock declarations
// vs. imports below is intentional. Per project convention, jest.mock is
// preferred over jest.spyOn for SWC-compiled ESM modules.

jest.mock('@opentelemetry/sdk-node', () => {
  const sdkInstance = {
    start: jest.fn(),
    shutdown: jest.fn().mockResolvedValue(undefined),
  };
  return {
    NodeSDK: jest.fn(() => sdkInstance),
    __sdkInstance: sdkInstance,
  };
});

jest.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: jest.fn(() => ['auto-instrumentations-sentinel']),
}));

jest.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: jest.fn((attrs: Record<string, unknown>) => ({ attributes: attrs })),
}));

jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: jest.fn().mockImplementation(() => ({ __transport: 'http' })),
}));

jest.mock('@opentelemetry/exporter-trace-otlp-grpc', () => ({
  OTLPTraceExporter: jest.fn().mockImplementation(() => ({ __transport: 'grpc' })),
}));

jest.mock('@opentelemetry/exporter-metrics-otlp-http', () => ({
  OTLPMetricExporter: jest.fn().mockImplementation(() => ({ __metric_transport: 'http' })),
}));

jest.mock('@opentelemetry/exporter-metrics-otlp-grpc', () => ({
  OTLPMetricExporter: jest.fn().mockImplementation(() => ({ __metric_transport: 'grpc' })),
}));

jest.mock('@opentelemetry/sdk-trace-base', () => {
  const actual = jest.requireActual<typeof import('@opentelemetry/sdk-trace-base')>('@opentelemetry/sdk-trace-base');
  return {
    ...actual,
    BatchSpanProcessor: jest.fn().mockImplementation((exporter: unknown) => ({
      __kind: 'BatchSpanProcessor',
      exporter,
    })),
  };
});

jest.mock('@opentelemetry/sdk-metrics', () => {
  const actual = jest.requireActual<typeof import('@opentelemetry/sdk-metrics')>('@opentelemetry/sdk-metrics');
  return {
    ...actual,
    PeriodicExportingMetricReader: jest.fn().mockImplementation((options: { exporter: unknown }) => ({
      __kind: 'PeriodicExportingMetricReader',
      exporter: options.exporter,
    })),
  };
});

import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { noopActorContextProvider } from '../processors/actor-context-provider';
import { ActorSpanProcessor } from '../processors/actor-span.processor';
import { initOtel } from './init-otel';
import type { OtelInitConfig } from './otel.config';

interface CapturedSdkConfig {
  spanProcessors: SpanProcessor[];
  resource: { attributes: Record<string, unknown> };
  instrumentations: unknown[];
  metricReader?: MetricReader;
}

const NodeSDKMock = NodeSDK as unknown as jest.Mock;
const BatchSpanProcessorMock = BatchSpanProcessor as unknown as jest.Mock;
const PeriodicReaderMock = PeriodicExportingMetricReader as unknown as jest.Mock;
const HttpExporterMock = jest.requireMock('@opentelemetry/exporter-trace-otlp-http').OTLPTraceExporter as jest.Mock;
const GrpcExporterMock = jest.requireMock('@opentelemetry/exporter-trace-otlp-grpc').OTLPTraceExporter as jest.Mock;
const HttpMetricExporterMock = jest.requireMock('@opentelemetry/exporter-metrics-otlp-http')
  .OTLPMetricExporter as jest.Mock;
const GrpcMetricExporterMock = jest.requireMock('@opentelemetry/exporter-metrics-otlp-grpc')
  .OTLPMetricExporter as jest.Mock;
const sdkInstance = jest.requireMock('@opentelemetry/sdk-node').__sdkInstance as {
  start: jest.Mock;
  shutdown: jest.Mock;
};

const baseConfig: OtelInitConfig = {
  serviceName: 'bge-api-test',
  serviceVersion: '0.0.0',
  actorContextProvider: noopActorContextProvider,
};

const lastSdkConfig = (): CapturedSdkConfig =>
  NodeSDKMock.mock.calls[NodeSDKMock.mock.calls.length - 1][0] as CapturedSdkConfig;

describe('initOtel', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    delete process.env['OTEL_EXPORTER_OTLP_PROTOCOL'];
    delete process.env['OTEL_LOG_LEVEL'];
    delete process.env['OTEL_METRICS_EXPORTER'];
    delete process.env['OTEL_LOGS_EXPORTER'];
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('SDK lifecycle', () => {
    it('constructs the NodeSDK and starts it', () => {
      initOtel(baseConfig);

      expect(NodeSDKMock).toHaveBeenCalledTimes(1);
      expect(sdkInstance.start).toHaveBeenCalledTimes(1);
    });

    it('returns a handle that invokes sdk.shutdown', async () => {
      const handle = initOtel(baseConfig);

      await handle.shutdown();

      expect(sdkInstance.shutdown).toHaveBeenCalledTimes(1);
    });

    it('exposes the NodeSDK instance on the handle', () => {
      const handle = initOtel(baseConfig);

      expect(handle.sdk).toBe(NodeSDKMock.mock.results[0].value);
    });
  });

  describe('span processor registration', () => {
    it('registers ActorSpanProcessor unconditionally', () => {
      initOtel(baseConfig);

      const { spanProcessors } = lastSdkConfig();
      expect(spanProcessors).toEqual(expect.arrayContaining([expect.any(ActorSpanProcessor)]));
    });

    it('does NOT register a BatchSpanProcessor when no OTLP endpoint is set', () => {
      initOtel(baseConfig);

      const { spanProcessors } = lastSdkConfig();
      expect(spanProcessors).toHaveLength(1);
      expect(BatchSpanProcessorMock).not.toHaveBeenCalled();
    });

    it('registers a BatchSpanProcessor when OTLP endpoint is set', () => {
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318';

      initOtel(baseConfig);

      const { spanProcessors } = lastSdkConfig();
      expect(spanProcessors).toHaveLength(2);
      expect(BatchSpanProcessorMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('trace exporter protocol selection', () => {
    beforeEach(() => {
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318';
    });

    it('defaults to the HTTP exporter when OTEL_EXPORTER_OTLP_PROTOCOL is unset', () => {
      initOtel(baseConfig);

      expect(HttpExporterMock).toHaveBeenCalledTimes(1);
      expect(GrpcExporterMock).not.toHaveBeenCalled();
    });

    it('selects the gRPC exporter when OTEL_EXPORTER_OTLP_PROTOCOL=grpc', () => {
      process.env['OTEL_EXPORTER_OTLP_PROTOCOL'] = 'grpc';

      initOtel(baseConfig);

      expect(GrpcExporterMock).toHaveBeenCalledTimes(1);
      expect(HttpExporterMock).not.toHaveBeenCalled();
    });
  });

  describe('resource attributes', () => {
    it('stamps service.name and service.version from config', () => {
      initOtel({ ...baseConfig, serviceName: 'bge-coordinator', serviceVersion: '1.2.3' });

      const { resource } = lastSdkConfig();
      expect(resource.attributes['service.name']).toBe('bge-coordinator');
      expect(resource.attributes['service.version']).toBe('1.2.3');
    });

    it('defaults service.namespace to "bge"', () => {
      initOtel(baseConfig);

      const { resource } = lastSdkConfig();
      expect(resource.attributes['service.namespace']).toBe('bge');
    });

    it('stamps deployment.environment.name when provided', () => {
      initOtel({ ...baseConfig, environment: 'production' });

      const { resource } = lastSdkConfig();
      expect(resource.attributes['deployment.environment.name']).toBe('production');
    });

    it('omits deployment.environment.name when not provided', () => {
      initOtel(baseConfig);

      const { resource } = lastSdkConfig();
      expect(resource.attributes['deployment.environment.name']).toBeUndefined();
    });
  });

  describe('instrumentations', () => {
    it('registers the Node auto-instrumentations bundle', () => {
      const { getNodeAutoInstrumentations } = jest.requireMock('@opentelemetry/auto-instrumentations-node');

      initOtel(baseConfig);

      expect(getNodeAutoInstrumentations).toHaveBeenCalledTimes(1);
      const { instrumentations } = lastSdkConfig();
      expect(instrumentations).toEqual([['auto-instrumentations-sentinel']]);
    });
  });

  describe('signal exporter defaults', () => {
    it('defaults OTEL_METRICS_EXPORTER to "none" when unset', () => {
      initOtel(baseConfig);

      expect(process.env['OTEL_METRICS_EXPORTER']).toBe('none');
    });

    it('defaults OTEL_LOGS_EXPORTER to "none" when unset', () => {
      initOtel(baseConfig);

      expect(process.env['OTEL_LOGS_EXPORTER']).toBe('none');
    });

    it('respects an explicit OTEL_METRICS_EXPORTER=otlp', () => {
      process.env['OTEL_METRICS_EXPORTER'] = 'otlp';

      initOtel(baseConfig);

      expect(process.env['OTEL_METRICS_EXPORTER']).toBe('otlp');
    });

    it('respects an explicit OTEL_LOGS_EXPORTER=otlp', () => {
      process.env['OTEL_LOGS_EXPORTER'] = 'otlp';

      initOtel(baseConfig);

      expect(process.env['OTEL_LOGS_EXPORTER']).toBe('otlp');
    });
  });

  describe('metric reader registration', () => {
    it('does NOT register a metric reader by default', () => {
      initOtel(baseConfig);

      expect(PeriodicReaderMock).not.toHaveBeenCalled();
      expect(lastSdkConfig().metricReader).toBeUndefined();
    });

    it('does NOT register a metric reader when only OTEL_METRICS_EXPORTER=otlp is set (endpoint missing)', () => {
      process.env['OTEL_METRICS_EXPORTER'] = 'otlp';
      // endpoint deliberately unset

      initOtel(baseConfig);

      expect(PeriodicReaderMock).not.toHaveBeenCalled();
      expect(lastSdkConfig().metricReader).toBeUndefined();
    });

    it('does NOT register a metric reader when only the endpoint is set (exporter=none)', () => {
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318';
      // exporter remains at the "none" default

      initOtel(baseConfig);

      expect(PeriodicReaderMock).not.toHaveBeenCalled();
      expect(lastSdkConfig().metricReader).toBeUndefined();
    });

    it('registers a PeriodicExportingMetricReader when both opt-in conditions are met', () => {
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318';
      process.env['OTEL_METRICS_EXPORTER'] = 'otlp';

      initOtel(baseConfig);

      expect(PeriodicReaderMock).toHaveBeenCalledTimes(1);
      expect(lastSdkConfig().metricReader).toBeDefined();
    });

    it('defaults to the HTTP metric exporter when protocol is unset', () => {
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318';
      process.env['OTEL_METRICS_EXPORTER'] = 'otlp';

      initOtel(baseConfig);

      expect(HttpMetricExporterMock).toHaveBeenCalledTimes(1);
      expect(GrpcMetricExporterMock).not.toHaveBeenCalled();
    });

    it('selects the gRPC metric exporter when OTEL_EXPORTER_OTLP_PROTOCOL=grpc', () => {
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318';
      process.env['OTEL_EXPORTER_OTLP_PROTOCOL'] = 'grpc';
      process.env['OTEL_METRICS_EXPORTER'] = 'otlp';

      initOtel(baseConfig);

      expect(GrpcMetricExporterMock).toHaveBeenCalledTimes(1);
      expect(HttpMetricExporterMock).not.toHaveBeenCalled();
    });

    it('respects an explicit OTEL_METRICS_EXPORTER=none even when endpoint is set', () => {
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318';
      process.env['OTEL_METRICS_EXPORTER'] = 'none';

      initOtel(baseConfig);

      expect(PeriodicReaderMock).not.toHaveBeenCalled();
      expect(lastSdkConfig().metricReader).toBeUndefined();
    });
  });
});
