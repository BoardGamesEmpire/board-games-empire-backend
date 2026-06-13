import { bootstrapLogging } from '@bge/logger';
import { diag, type DiagLogger } from '@opentelemetry/api';
import type { Logger as PinoInstance } from 'pino';
import { resolveDiagLogLevel } from '../init/diag-log-level';
import { initOtel, type OtelBootstrapHandle } from '../init/init-otel';
import type { OtelInitConfig } from '../init/otel.config';
import { buildOtelPinoOptions } from '../pino/otel-pino.options';

/**
 * Bundle returned from {@link bootstrapObservability}.
 *
 * Only one logger is returned — `baseLogger` — with the always-true
 * `service` binding from {@link bootstrapLogging}. It is the logger
 * intended for the LoggerModule / `pinoHttp.logger` slot; nestjs-pino
 * will create per-context child loggers from it.
 *
 * Apps that want a `component: 'bootstrap'`-tagged child for pre-Nest
 * lines, shutdown handlers, and `bootstrap().catch(...)` failure
 * paths derive one locally in their `lib/logger.ts`:
 *
 * ```ts
 * const { otel, baseLogger } = bootstrapObservability({...});
 * const bootstrapLogger = baseLogger.child({ component: 'bootstrap' });
 * export { otel, baseLogger, bootstrapLogger };
 * ```
 *
 * Inside this helper, an internal `component: 'bootstrap'` child is
 * created strictly for the diag bridge (so SDK-internal lines are
 * filterable as bootstrap output) and the "OpenTelemetry SDK
 * initialized" record. That child is not exported because it is an
 * implementation detail of the SDK plumbing, not the surface of the
 * helper. Both bootstrap children share the same underlying pino
 * transport, so there is no double-shipping.
 */
export interface BootstrapObservabilityResult {
  readonly otel: OtelBootstrapHandle;
  /**
   * Runtime base logger. Pass this to
   * `LoggerModule.forRoot({ pinoHttp: { logger: baseLogger } })`.
   * Carries only the `service` binding — NestJS / nestjs-pino will
   * layer its own per-context bindings on top.
   */
  readonly baseLogger: PinoInstance;
}

/**
 * Adapts a pino instance to OpenTelemetry's {@link DiagLogger} surface
 * so SDK-internal diagnostic output flows through the same pipeline
 * as application logs.
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
 * One-call OpenTelemetry + base-logger setup for application entry
 * points. MUST be called at the very top of `main.ts`, BEFORE any
 * module that should be auto-instrumented is imported — the SDK
 * installs instrumentations by patching modules at require time, so
 * any module already loaded misses the hook.
 *
 * Performs three steps in order:
 * 1. Construct the base pino instance via `@bge/logger`'s
 *    {@link bootstrapLogging}, passing the OTel-augmented options from
 *    {@link buildOtelPinoOptions}. The returned logger carries the
 *    `service` binding.
 * 2. Call {@link initOtel} to start the NodeSDK.
 * 3. Replace the default `diag` console logger with one that forwards
 *    SDK-internal messages through a `component: 'bootstrap'`-tagged
 *    child of the base logger. The level is resolved from
 *    `OTEL_LOG_LEVEL` via {@link resolveDiagLogLevel} — the same
 *    helper that `initOtel` uses for its initial diag setup, so the
 *    operator's selection survives this upgrade.
 *
 * Idempotency: this helper is not idempotent — calling it twice will
 * attempt to start the OTel SDK twice and the second call will throw
 * from `NodeSDK.start()`. Call it once per process.
 */
export function bootstrapObservability(config: OtelInitConfig): BootstrapObservabilityResult {
  const baseLogger = bootstrapLogging({ serviceName: config.serviceName }, buildOtelPinoOptions());
  const internalBootstrapLogger = baseLogger.child({ component: 'bootstrap' });

  const otel = initOtel(config);

  diag.setLogger(buildDiagLogger(internalBootstrapLogger), resolveDiagLogLevel());
  internalBootstrapLogger.info(
    { serviceName: config.serviceName, serviceVersion: config.serviceVersion },
    'OpenTelemetry SDK initialized',
  );

  return { otel, baseLogger };
}
