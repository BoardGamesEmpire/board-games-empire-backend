import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter as OtlpGrpcMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPMetricExporter as OtlpHttpMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter as OtlpGrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as OtlpHttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader, type MetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ActorSpanProcessor } from '../processors/actor-span.processor';
import {
  DEFAULT_SERVICE_NAMESPACE,
  OTEL_EXPORTER_NONE,
  OTEL_EXPORTER_OTLP_ENDPOINT_ENV,
  OTEL_EXPORTER_OTLP_PROTOCOL_ENV,
  OTEL_LOGS_EXPORTER_ENV,
  OTEL_METRICS_EXPORTER_ENV,
  OTEL_OTLP_PROTOCOL_GRPC,
  OTEL_OTLP_PROTOCOL_HTTP,
  type OtelInitConfig,
} from './otel.config';

/**
 * Handle returned from {@link initOtel}. Hold onto this in `main.ts` so
 * Nest's shutdown hooks can call `shutdown()` to flush pending exports.
 */
export interface OtelBootstrapHandle {
  readonly sdk: NodeSDK;
  shutdown(): Promise<void>;
}

/**
 * Resolves the trace exporter based on standard OTel env vars. Returns
 * `undefined` when no endpoint is configured — the SDK then runs the
 * instrumentation pipeline but does not export. Defaults to
 * `http/protobuf` per the OTel SDK default.
 */
const resolveTraceExporter = (env: NodeJS.ProcessEnv): SpanExporter | undefined => {
  if (!env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV]) {
    return undefined;
  }
  const protocol = env[OTEL_EXPORTER_OTLP_PROTOCOL_ENV] ?? OTEL_OTLP_PROTOCOL_HTTP;
  return protocol === OTEL_OTLP_PROTOCOL_GRPC ? new OtlpGrpcTraceExporter() : new OtlpHttpTraceExporter();
};

/**
 * Resolves the metric reader based on opt-in env-var configuration.
 *
 * Returns `undefined` (no MeterProvider registered) unless BOTH:
 * - `OTEL_METRICS_EXPORTER=otlp` (explicit opt-in; default is `'none'`
 *   via {@link defaultSignalExporters}).
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 *
 * When unset, `metrics.getMeter` returns a `NoopMeter` and instruments
 * (including those registered by {@link BullMQMetricsService}) become
 * no-ops. This is safe to call from any code path without coordination.
 *
 * Export interval respects `OTEL_METRIC_EXPORT_INTERVAL` via the
 * `PeriodicExportingMetricReader` default behaviour (60s when unset).
 */
const resolveMetricReader = (env: NodeJS.ProcessEnv): MetricReader | undefined => {
  if (env[OTEL_METRICS_EXPORTER_ENV] !== 'otlp') {
    return undefined;
  }
  if (!env[OTEL_EXPORTER_OTLP_ENDPOINT_ENV]) {
    return undefined;
  }

  const protocol = env[OTEL_EXPORTER_OTLP_PROTOCOL_ENV] ?? OTEL_OTLP_PROTOCOL_HTTP;
  const exporter = protocol === OTEL_OTLP_PROTOCOL_GRPC ? new OtlpGrpcMetricExporter() : new OtlpHttpMetricExporter();

  return new PeriodicExportingMetricReader({ exporter });
};

/**
 * Defaults metrics and logs exporter env vars to `'none'` so NodeSDK
 * skips its auto-configuration of periodic exporters for those signals.
 *
 * Why: when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, NodeSDK auto-configures
 * an OTLP exporter for every signal (traces, metrics, logs) by default.
 *
 * - Metrics: the BGE metric infrastructure is opt-in via
 *   `OTEL_METRICS_EXPORTER=otlp`; in that case {@link resolveMetricReader}
 *   provides an explicit reader. NodeSDK's auto-setup is bypassed by
 *   passing our own `metricReader` AND we still default the env to
 *   `'none'` so any code path that introspects the env sees an
 *   unambiguous "no auto-setup" state.
 * - Logs: `pino-opentelemetry-transport` ships logs from a pino worker
 *   thread. A second SDK-side log exporter would double-ship every
 *   record.
 *
 * Respects explicit user configuration — if the operator sets either
 * var (to `'otlp'`, `'none'`, `'console'`, ...) we leave it alone.
 */
const defaultSignalExporters = (env: NodeJS.ProcessEnv): void => {
  if (env[OTEL_METRICS_EXPORTER_ENV] === undefined) {
    env[OTEL_METRICS_EXPORTER_ENV] = OTEL_EXPORTER_NONE;
  }
  if (env[OTEL_LOGS_EXPORTER_ENV] === undefined) {
    env[OTEL_LOGS_EXPORTER_ENV] = OTEL_EXPORTER_NONE;
  }
};

/**
 * Bootstraps the OpenTelemetry NodeSDK.
 *
 * MUST be called at the very top of `main.ts`, BEFORE `NestFactory.create`
 * and BEFORE importing any module that should be auto-instrumented. The
 * NodeSDK's auto-instrumentations install themselves by patching modules
 * at require/import time; modules already loaded miss the hook.
 *
 * Behavior:
 * - {@link ActorSpanProcessor} is registered unconditionally — it has no
 *   exporter dependency and is cheap. Its provider reads the current
 *   audit context (from CLS or a stub) on every span start.
 * - A {@link BatchSpanProcessor} is registered ONLY when
 *   `OTEL_EXPORTER_OTLP_ENDPOINT` is set, choosing the gRPC or HTTP
 *   exporter from `OTEL_EXPORTER_OTLP_PROTOCOL`.
 * - A {@link PeriodicExportingMetricReader} is registered ONLY when the
 *   operator explicitly sets `OTEL_METRICS_EXPORTER=otlp` AND endpoint
 *   is set. Default is no reader → metric instruments (including
 *   `bullmq.queue.jobs` from `BullMQMetricsService`) become no-ops.
 * - `OTEL_LOGS_EXPORTER` is defaulted to `'none'` when unset — see
 *   {@link defaultSignalExporters}.
 * - Internal OTel diagnostic logs are forwarded through `diag` to stderr
 *   when `OTEL_LOG_LEVEL` is set, so misconfiguration surfaces during
 *   bootstrap. Apps using `bootstrapObservability` override this with a
 *   pino-backed `DiagLogger` immediately after this call returns.
 *
 * The returned handle's `shutdown` should be invoked from a Nest shutdown
 * hook (or a process signal handler) to drain in-flight exports.
 */
export const initOtel = (config: OtelInitConfig): OtelBootstrapHandle => {
  if (process.env['OTEL_LOG_LEVEL']) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  defaultSignalExporters(process.env);

  const resource = resourceFromAttributes({
    'service.name': config.serviceName,
    'service.version': config.serviceVersion,
    'service.namespace': config.serviceNamespace ?? DEFAULT_SERVICE_NAMESPACE,
    ...(config.environment ? { 'deployment.environment.name': config.environment } : {}),
  });

  const spanProcessors: SpanProcessor[] = [new ActorSpanProcessor(config.actorContextProvider)];

  const exporter = resolveTraceExporter(process.env);
  if (exporter) {
    spanProcessors.push(new BatchSpanProcessor(exporter));
  }

  const metricReader = resolveMetricReader(process.env);
  const sdk = new NodeSDK({
    resource,
    spanProcessors,
    instrumentations: [getNodeAutoInstrumentations()],
    ...(metricReader && { metricReader }),
  });

  sdk.start();

  return {
    sdk,
    shutdown: () => sdk.shutdown(),
  };
};
