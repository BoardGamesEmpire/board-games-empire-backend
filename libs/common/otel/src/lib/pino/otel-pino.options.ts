import { env as environment } from '@bge/env';
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
 * - When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, `pino-opentelemetry-transport`
 *   is configured as the pino transport target. Logs are forwarded to the
 *   OTel Logs SDK and exported via the OTLP collector alongside spans.
 *   `OTEL_RESOURCE_ATTRIBUTES` is forwarded so log records share the same
 *   Resource as their associated spans.
 * - When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, no transport is
 *   configured — pino falls back to its default (stdout) behavior.
 *
 * Designed to be merged into `nestjs-pino`'s `LoggerModule` configuration
 * via spread. The caller is responsible for app-specific pino options
 * (log level, serializers, redaction rules).
 */
export function buildOtelPinoOptions(env: NodeJS.ProcessEnv = process.env): LoggerOptions {
  const level = environment.provide('LOG_LEVEL', {
    defaultValue: environment.isProduction ? 'info' : 'debug',
  });

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
