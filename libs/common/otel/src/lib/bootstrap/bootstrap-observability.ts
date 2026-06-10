import { diag, type DiagLogger } from '@opentelemetry/api';
import pino, { type Logger as PinoInstance } from 'pino';
import { resolveDiagLogLevel } from '../init/diag-log-level';
import { initOtel, type OtelBootstrapHandle } from '../init/init-otel';
import type { OtelInitConfig } from '../init/otel.config';
import { buildOtelPinoOptions } from '../pino/otel-pino.options';

/**
 * Bundle returned from {@link bootstrapObservability}.
 *
 * Two pino loggers are returned because they serve different roles:
 *
 * - `baseLogger` carries only the always-true `service` binding and is
 *   intended as the base logger passed to `LoggerModule` /
 *   `pinoHttp.logger`. NestJS / nestjs-pino will create per-context
 *   child loggers from it, inheriting only `service` plus whatever
 *   `context` the framework adds. Use this everywhere a runtime log
 *   originates.
 *
 * - `bootstrapLogger` is a child of `baseLogger` with an additional
 *   `component: 'bootstrap'` binding, intended for pre-Nest log lines
 *   (the diag bridge, the "OpenTelemetry SDK initialized" message),
 *   shutdown handlers, and the `bootstrap().catch(...)` failure path
 *   in `main.ts`. The binding makes those records distinguishable in
 *   the log backend so operators can filter the cold-start phase.
 *
 * Both share the same underlying pino transport — child loggers don't
 * create new transports — so there's no double-shipping when
 * `pino-opentelemetry-transport` is wired by `buildOtelPinoOptions`.
 *
 * The first form of this helper returned a single logger pre-bound
 * with `component: 'bootstrap'`. Using it as the LoggerModule base
 * silently tagged every runtime log as a bootstrap log, which broke
 * log filtering and misled anyone reading the backend.
 */
export interface BootstrapObservabilityResult {
  readonly otel: OtelBootstrapHandle;
  /**
   * Runtime base logger. Pass this to `LoggerModule.forRoot({ pinoHttp: { logger: baseLogger } })`.
   * Carries only the `service` binding — NestJS / nestjs-pino will
   * layer its own per-context bindings on top.
   */
  readonly baseLogger: PinoInstance;

  /**
   * Bootstrap-tagged child logger. Use for pre-Nest log lines,
   * shutdown handlers, and bootstrap-failure paths in `main.ts`.
   * Carries `service` (inherited) plus `component: 'bootstrap'`.
   */
  readonly bootstrapLogger: PinoInstance;
}

/**
 * Adapts a pino instance to OpenTelemetry's {@link DiagLogger} surface so
 * SDK-internal diagnostic output flows through the same pipeline as
 * application logs.
 */
function buildDiagLogger(logger: PinoInstance): DiagLogger {
  return {
    verbose: (message, ...args) => logger.trace({ otel: args }, message),
    debug: (message, ...args) => logger.debug({ otel: args }, message),
    info: (message, ...args) => logger.info({ otel: args }, message),
    warn: (message, ...args) => logger.warn({ otel: args }, message),
    error: (message, ...args) => logger.error({ otel: args }, message),
  };
}

/**
 * One-call OpenTelemetry + bootstrap-logger setup for application entry
 * points. MUST be called at the very top of `main.ts`, BEFORE any module
 * that should be auto-instrumented is imported — the SDK installs
 * instrumentations by patching modules at require time, so any module
 * already loaded misses the hook.
 *
 * Performs three steps in order:
 * 1. Construct a pino instance from {@link buildOtelPinoOptions}. Two
 *    child loggers are derived: `baseLogger` (with only the `service`
 *    binding, for runtime app logs) and `bootstrapLogger` (with the
 *    additional `component: 'bootstrap'` binding, for pre-Nest /
 *    shutdown / bootstrap-failure logs).
 * 2. Call {@link initOtel} to start the NodeSDK.
 * 3. Replace the default `diag` console logger with one that forwards
 *    SDK-internal messages through `bootstrapLogger`. The level is
 *    resolved from `OTEL_LOG_LEVEL` via
 *    {@link resolveDiagLogLevel} — the same helper that `initOtel`
 *    uses for its initial diag setup, so the operator's selection
 *    survives this upgrade.
 *
 * Idempotency: this helper is not idempotent — calling it twice will
 * attempt to start the OTel SDK twice and the second call will throw
 * from `NodeSDK.start()`. Call it once per process.
 */
export function bootstrapObservability(config: OtelInitConfig): BootstrapObservabilityResult {
  const baseLogger = pino(buildOtelPinoOptions()).child({
    service: config.serviceName,
  });
  const bootstrapLogger = baseLogger.child({
    component: 'bootstrap',
  });

  const otel = initOtel(config);

  diag.setLogger(buildDiagLogger(bootstrapLogger), resolveDiagLogLevel());
  bootstrapLogger.info(
    { serviceName: config.serviceName, serviceVersion: config.serviceVersion },
    'OpenTelemetry SDK initialized',
  );

  return { otel, baseLogger, bootstrapLogger };
}
