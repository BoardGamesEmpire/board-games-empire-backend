import { diag, type DiagLogger, DiagLogLevel } from '@opentelemetry/api';
import pino, { type Logger as PinoInstance } from 'pino';
import { initOtel, type OtelBootstrapHandle } from '../init/init-otel';
import type { OtelInitConfig } from '../init/otel.config';
import { buildOtelPinoOptions } from '../pino/otel-pino.options';

/**
 * Bundle returned from {@link bootstrapObservability} — the OTel handle
 * (for shutdown sequencing) and a bootstrap pino instance for pre-Nest
 * logging.
 */
export interface BootstrapObservabilityResult {
  readonly otel: OtelBootstrapHandle;
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
 * 1. Construct a pino instance from {@link buildOtelPinoOptions}, scoped
 *    with `service` + `component: 'bootstrap'` child bindings.
 * 2. Call {@link initOtel} to start the NodeSDK.
 * 3. Replace the default `diag` console logger with one that forwards
 *    SDK-internal messages through the bootstrap pino.
 *
 * Idempotency: this helper is not idempotent — calling it twice will
 * attempt to start the OTel SDK twice and the second call will throw
 * from `NodeSDK.start()`. Call it once per process.
 */
export function bootstrapObservability(config: OtelInitConfig): BootstrapObservabilityResult {
  const bootstrapLogger = pino(buildOtelPinoOptions()).child({
    service: config.serviceName,
    component: 'bootstrap',
  });

  const otel = initOtel(config);

  diag.setLogger(buildDiagLogger(bootstrapLogger), DiagLogLevel.INFO);
  bootstrapLogger.info(
    { serviceName: config.serviceName, serviceVersion: config.serviceVersion },
    'OpenTelemetry SDK initialized',
  );

  return { otel, bootstrapLogger };
}
