import { buildBasePinoOptions, resolvePinoLevel } from '@bge/logger';
import { context, trace } from '@opentelemetry/api';
import type { LoggerOptions, TransportTargetOptions } from 'pino';

/**
 * Trace-flag value rendered as a zero-padded two-character hex string,
 * matching the W3C Trace Context wire format (`traceparent`'s third
 * segment). OTel exposes the same value as a numeric byte; we render
 * it for log records so log aggregators can group by sampling
 * decision.
 */
const renderTraceFlags = (traceFlags: number): string => traceFlags.toString(16).padStart(2, '0');

/**
 * Pino `mixin` that injects W3C trace correlation fields onto every
 * log record when an active OTel span exists. Field names follow the
 * OpenTelemetry log data model recommendation (`trace_id`, `span_id`,
 * `trace_flags`) so OTLP log shippers can lift them into the
 * `LogRecord` envelope without remapping.
 *
 * Layered alongside `@opentelemetry/instrumentation-pino`, which
 * patches pino at instantiation time. The mixin provides a defensive
 * backstop for code paths the instrumentation patch may miss —
 * custom transports, child loggers built before the SDK started, etc.
 *
 * Returns `{}` (no fields added) when no active span exists.
 */
export function otelTraceMixin(): Record<string, string> {
  const span = trace.getSpan(context.active());
  if (!span) {
    return {};
  }

  const { traceId, spanId, traceFlags } = span.spanContext();
  return {
    trace_id: traceId,
    span_id: spanId,
    trace_flags: renderTraceFlags(traceFlags),
  };
}

/**
 * Returns pino options pre-configured for OpenTelemetry integration,
 * composed on top of `buildBasePinoOptions` from `@bge/logger`:
 *
 * - {@link otelTraceMixin} is always applied so every record carries
 *   trace correlation when a span is active.
 * - The log level and the `pino-pretty` transport target are taken
 *   verbatim from the base options. Level resolution is centralized
 *   in `@bge/logger`'s {@link resolvePinoLevel} so the appended OTLP
 *   target picks up the same value.
 * - When `env['OTEL_EXPORTER_OTLP_ENDPOINT']` is set,
 *   `pino-opentelemetry-transport` is appended as a second target.
 *   Logs are forwarded to the OTel Logs SDK and exported via the
 *   OTLP collector alongside spans. `env['OTEL_RESOURCE_ATTRIBUTES']`
 *   is forwarded so log records share the same Resource as their
 *   associated spans.
 *
 * Every env-derived value is read from the `env` parameter (default:
 * `process.env`). Mirrors the contract on {@link buildBasePinoOptions}
 * — callers control the produced options fully by passing a custom
 * `env` object, which keeps tests deterministic.
 *
 * Designed to be passed to `bootstrapLogging` (via
 * `bootstrapObservability`) for service-wide pino setup. The caller
 * is responsible for app-specific pino options not derived from env
 * (serializers, redaction rules, custom hooks).
 */
export function buildOtelPinoOptions(env: NodeJS.ProcessEnv = process.env): LoggerOptions {
  const base = buildBasePinoOptions(env);
  const level = resolvePinoLevel(env);

  // pino's `TransportMultiOptions.targets` is a `readonly` array of
  // `TransportTargetOptions | TransportPipelineOptions`. `.filter()`
  // with a type guard does double duty: it produces a fresh mutable
  // array we can push the OTLP target onto, and narrows away the
  // pipeline variant (which has no required `target` field —
  // `buildBasePinoOptions` never emits one, but TS can't know that
  // from the union alone).
  const existingTargets: TransportTargetOptions[] =
    base.transport && 'targets' in base.transport
      ? base.transport.targets.filter((t): t is TransportTargetOptions => 'target' in t)
      : [];

  const transportTargets: TransportTargetOptions[] = [...existingTargets];

  if (env['OTEL_EXPORTER_OTLP_ENDPOINT']) {
    transportTargets.push({
      target: 'pino-opentelemetry-transport',
      level,
      options: {
        resourceAttributes: env['OTEL_RESOURCE_ATTRIBUTES'],
      },
    });
  }

  return {
    ...base,
    mixin: otelTraceMixin,
    transport: {
      targets: transportTargets,
    },
  };
}
