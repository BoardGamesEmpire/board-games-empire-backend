import { context, trace } from '@opentelemetry/api';
import type { LoggerOptions, TransportTargetOptions } from 'pino';

/**
 * Trace-flag value rendered as a zero-padded two-character hex string,
 * matching the W3C Trace Context wire format (`traceparent`'s third
 * segment). OTel exposes the same value as a numeric byte; we render it
 * for log records so log aggregators can group by sampling decision.
 */
const renderTraceFlags = (traceFlags: number): string => traceFlags.toString(16).padStart(2, '0');

/**
 * Pino `mixin` that injects W3C trace correlation fields onto every log
 * record when an active OTel span exists. Field names follow the
 * OpenTelemetry log data model recommendation (`trace_id`, `span_id`,
 * `trace_flags`) so OTLP log shippers can lift them into the
 * `LogRecord` envelope without remapping.
 *
 * Layered alongside `@opentelemetry/instrumentation-pino`, which patches
 * pino at instantiation time. The mixin provides a defensive backstop for
 * code paths the instrumentation patch may miss — custom transports,
 * child loggers built before the SDK started, etc.
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
 * Returns pino options pre-configured for OpenTelemetry integration:
 *
 * - {@link otelTraceMixin} is always applied so every record carries
 *   trace correlation when a span is active.
 * - The log level is read from `env['LOG_LEVEL']`, defaulting to
 *   `'info'` when `env['NODE_ENV'] === 'production'` and `'debug'`
 *   otherwise.
 * - A `pino-pretty` transport target is always configured.
 * - When `env['OTEL_EXPORTER_OTLP_ENDPOINT']` is set,
 *   `pino-opentelemetry-transport` is added as a second target. Logs
 *   are forwarded to the OTel Logs SDK and exported via the OTLP
 *   collector alongside spans. `env['OTEL_RESOURCE_ATTRIBUTES']` is
 *   forwarded so log records share the same Resource as their
 *   associated spans.
 *
 * Every env-derived value is read from the `env` parameter (default:
 * `process.env`). The function intentionally does not consult
 * `@bge/env` or `process.env` directly — passing a custom `env` object
 * fully controls the produced options, which keeps tests deterministic
 * and matches the parameter contract a caller would reasonably expect.
 *
 * Designed to be merged into `nestjs-pino`'s `LoggerModule` configuration
 * via spread. The caller is responsible for app-specific pino options
 * not derived from env (serializers, redaction rules, custom hooks).
 */
export function buildOtelPinoOptions(env: NodeJS.ProcessEnv = process.env): LoggerOptions {
  const isProduction = env['NODE_ENV'] === 'production';
  const level = env['LOG_LEVEL'] ?? (isProduction ? 'info' : 'debug');

  const transportTargets: TransportTargetOptions[] = [
    {
      target: 'pino-pretty',
      level,
      options: {
        colorize: true,
        singleLine: true,
      },
    },
  ];

  if (env['OTEL_EXPORTER_OTLP_ENDPOINT']) {
    transportTargets.push({
      target: 'pino-opentelemetry-transport',
      level,
      options: {
        resourceAttributes: env['OTEL_RESOURCE_ATTRIBUTES'],
      },
    });
  }

  const options: LoggerOptions = {
    mixin: otelTraceMixin,
    level,
    transport: {
      targets: transportTargets,
    },
  };

  return options;
}
