import { diag, DiagConsoleLogger } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter as OtlpGrpcMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPMetricExporter as OtlpHttpMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter as OtlpGrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as OtlpHttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { MetricReader } from '@opentelemetry/sdk-metrics';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import { ActorSpanProcessor } from '../processors/actor-span.processor';
import { OTEL_LOG_LEVEL_ENV, resolveDiagLogLevel } from './diag-log-level';
import { resolveMetricExportTiming } from './metric-export-env';
import { metricsExportEnabled } from './metrics-enabled';
import type { OtelInitConfig } from './otel.config';
import {
  DEFAULT_SERVICE_NAMESPACE,
  OTEL_BSP_EXPORT_TIMEOUT_ENV,
  OTEL_BSP_MAX_EXPORT_BATCH_SIZE_ENV,
  OTEL_BSP_MAX_QUEUE_SIZE_ENV,
  OTEL_BSP_SCHEDULE_DELAY_ENV,
  OTEL_EXPORTER_NONE,
  OTEL_EXPORTER_OTLP_ENDPOINT_ENV,
  OTEL_EXPORTER_OTLP_PROTOCOL_ENV,
  OTEL_LOGS_EXPORTER_ENV,
  OTEL_METRICS_EXPORTER_ENV,
  OTEL_OTLP_PROTOCOL_GRPC,
  OTEL_OTLP_PROTOCOL_HTTP,
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
 * Reads one of the spec's numeric SDK variables. Unset, blank, non-numeric
 * and non-positive values all yield `undefined`, so the processor keeps its
 * own default; a value that is set but unusable is reported through `diag`,
 * as NodeSDK reports its own.
 */
const positiveNumberFromEnv = (env: NodeJS.ProcessEnv, name: string): number | undefined => {
  const raw = env[name]?.trim();
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    diag.warn(`${name} (${raw}) is invalid, expected a number greater than 0; using the default.`);
    return undefined;
  }

  return value;
};

/**
 * Builds the batch span processor with the spec's `OTEL_BSP_*` tuning
 * variables. Up to sdk-trace-base 2.x the processor read them itself; from
 * sdk-trace 3 it takes only what it is given, and NodeSDK reads them only
 * for processors it builds, not for ones passed in `spanProcessors`. Reading
 * them here keeps an operator's tuning working across the upgrade (#957).
 */
const createBatchSpanProcessor = (exporter: SpanExporter, env: NodeJS.ProcessEnv): BatchSpanProcessor =>
  new BatchSpanProcessor({
    exporter,
    exportTimeoutMillis: positiveNumberFromEnv(env, OTEL_BSP_EXPORT_TIMEOUT_ENV),
    maxExportBatchSize: positiveNumberFromEnv(env, OTEL_BSP_MAX_EXPORT_BATCH_SIZE_ENV),
    maxQueueSize: positiveNumberFromEnv(env, OTEL_BSP_MAX_QUEUE_SIZE_ENV),
    scheduledDelayMillis: positiveNumberFromEnv(env, OTEL_BSP_SCHEDULE_DELAY_ENV),
  });

/**
 * Resolves the metric reader based on opt-in env-var configuration.
 *
 * Returns `undefined` (no MeterProvider registered) unless
 * {@link metricsExportEnabled} returns true — i.e. `OTEL_METRICS_EXPORTER=otlp`
 * AND at least one OTLP endpoint env (`OTEL_EXPORTER_OTLP_ENDPOINT` or
 * the per-signal `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`) is set. The
 * default for `OTEL_METRICS_EXPORTER` is `'none'` per
 * {@link defaultSignalExporters}, so the operator must opt in
 * deliberately.
 *
 * When the gate is closed, `metrics.getMeter` returns a `NoopMeter` and
 * every instrument registered by `bullmq-otel` (driven by
 * `BullMQQueueDepthRecorder`) and the auto-instrumentations becomes a
 * no-op. Safe to call from any code path without coordination.
 *
 * Export interval and timeout come from `OTEL_METRIC_EXPORT_INTERVAL` and
 * `OTEL_METRIC_EXPORT_TIMEOUT` via {@link resolveMetricExportTiming}. The
 * reader doesn't read them itself, and NodeSDK reads them only for
 * readers it builds, so they are passed here (#1436).
 */
const resolveMetricReader = (env: NodeJS.ProcessEnv): MetricReader | undefined => {
  if (!metricsExportEnabled(env)) {
    return undefined;
  }

  const protocol = env[OTEL_EXPORTER_OTLP_PROTOCOL_ENV] ?? OTEL_OTLP_PROTOCOL_HTTP;
  const exporter = protocol === OTEL_OTLP_PROTOCOL_GRPC ? new OtlpGrpcMetricExporter() : new OtlpHttpMetricExporter();

  return new PeriodicExportingMetricReader({ exporter, ...resolveMetricExportTiming(env) });
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
 *   passing our own `metricReaders` AND we still default the env to
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
 *   gate in {@link metricsExportEnabled} is open — `OTEL_METRICS_EXPORTER=otlp`
 *   plus an OTLP endpoint configured. Default is no reader → all metric
 *   instruments (those emitted by `bullmq-otel`, kept fresh by
 *   `BullMQQueueDepthRecorder`, and those from auto-instrumentations)
 *   become no-ops.
 * - `OTEL_LOGS_EXPORTER` is defaulted to `'none'` when unset — see
 *   {@link defaultSignalExporters}.
 * - Internal OTel diagnostic logs are forwarded through `diag` to stderr
 *   when `OTEL_LOG_LEVEL` is set; the level is resolved via
 *   {@link resolveDiagLogLevel}. Apps using `bootstrapObservability`
 *   override the diag transport with a pino-backed `DiagLogger`
 *   immediately after this call returns — that helper consults the
 *   same {@link resolveDiagLogLevel} so the operator's selection
 *   survives the upgrade.
 *
 * The returned handle's `shutdown` should be invoked from a Nest shutdown
 * hook (or a process signal handler) to drain in-flight exports.
 */
export const initOtel = (config: OtelInitConfig): OtelBootstrapHandle => {
  if (process.env[OTEL_LOG_LEVEL_ENV]) {
    diag.setLogger(new DiagConsoleLogger(), resolveDiagLogLevel());
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
    spanProcessors.push(createBatchSpanProcessor(exporter, process.env));
  }

  const metricReader = resolveMetricReader(process.env);
  const sdk = new NodeSDK({
    resource,
    spanProcessors,
    instrumentations: [getNodeAutoInstrumentations()],
    // `metricReaders`, plural: sdk-node 0.301 no longer reads the singular
    // `metricReader`, and a spread is not excess-property checked, so the
    // old key would compile and silently register no reader (#957).
    ...(metricReader && { metricReaders: [metricReader] }),
  });

  // NodeSDK.start() is synchronous and returns void in @opentelemetry/sdk-node 0.46+.
  // The instrumentation/context/propagator setup it performs is all sync
  // despite the name suggesting otherwise.
  sdk.start();

  return {
    sdk,
    shutdown: () => sdk.shutdown(),
  };
};
