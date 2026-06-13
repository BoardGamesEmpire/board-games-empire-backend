import pino, { type LoggerOptions, type Logger as PinoInstance } from 'pino';
import { buildBasePinoOptions } from './base-pino.options';

/**
 * Static configuration supplied by each app when constructing its base
 * pino logger. Kept as an interface (rather than a bare `serviceName`
 * string parameter) so additional always-true bindings can be added
 * later without a breaking signature change.
 */
export interface BootstrapLoggingConfig {
  /**
   * Logical service identifier, e.g. `'bge-api'`, `'bge-gateway-bgg'`.
   * Bound onto every record emitted by the returned logger and any
   * child loggers derived from it.
   */
  readonly serviceName: string;
}

/**
 * Constructs the BGE root pino logger and binds the `service`
 * attribute onto every record it emits.
 *
 * What you get back is intended to be passed straight to
 * `LoggerModule.forRoot({ pinoHttp: { logger } })` so that nestjs-pino
 * uses it as the underlying instance. The returned logger carries
 * only the `service` binding — Nest / nestjs-pino layers its own
 * per-context bindings (`context`, request id, etc.) on top. App
 * `main.ts` files that want a `component: 'bootstrap'` tag on
 * pre-Nest / shutdown lines should derive a child locally:
 *
 * ```ts
 * const baseLogger = bootstrapLogging({ serviceName: 'bge-foo' });
 * const bootstrapLogger = baseLogger.child({ component: 'bootstrap' });
 * ```
 *
 * The `options` parameter exists so `@bge/otel`'s
 * `bootstrapObservability` can layer the OTel-specific trace
 * correlation mixin and `pino-opentelemetry-transport` target onto
 * the base options (via `buildOtelPinoOptions`) before handing them
 * in. Gateways and other OTel-free services omit it and pick up the
 * defaults from {@link buildBasePinoOptions}.
 */
export function bootstrapLogging(
  config: BootstrapLoggingConfig,
  options: LoggerOptions = buildBasePinoOptions(),
): PinoInstance {
  return pino(options).child({ service: config.serviceName });
}
