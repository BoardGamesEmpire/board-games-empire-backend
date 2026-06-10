import type { INestApplicationContext } from '@nestjs/common';
import type { Logger as PinoInstance } from 'pino';
import type { OtelBootstrapHandle } from '../init/init-otel';

/**
 * Minimal app surface required for graceful shutdown. Compatible with
 * `INestApplication`, `INestMicroservice`, and `INestApplicationContext`
 * — all three expose `close()` which triggers `OnApplicationShutdown`
 * lifecycle hooks on registered providers.
 */
export type ShutdownableApp = Pick<INestApplicationContext, 'close'>;

/**
 * Async shutdown function returned by {@link createShutdown}. Calling it
 * with the same signal twice returns the in-flight promise rather than
 * running the sequence again — safe to bind to multiple process signals.
 */
export type ShutdownFn = (signal: NodeJS.Signals) => Promise<void>;

/**
 * Builds an idempotent async shutdown function that closes the Nest app
 * BEFORE flushing the OpenTelemetry exporter pipeline.
 *
 * The ordering is intentional: `app.close()` runs all
 * `OnApplicationShutdown` providers, which in turn produce their final
 * spans (e.g. Redis quit, BullMQ disconnect). OTel flushes AFTER those
 * providers complete so the trailing batch is exported rather than
 * discarded.
 *
 * Both `app.close()` and `otel.shutdown()` failures are logged but do
 * not abort the sequence — the goal is best-effort flush, not strict
 * correctness.
 *
 * Re-entrancy: the function caches its promise on first invocation.
 * Subsequent calls with any signal log a warning and return the cached
 * promise, preventing the sequence from running twice on rapid
 * SIGTERM/SIGINT.
 *
 * Note that this function does NOT call `process.exit` — that lives in
 * {@link registerShutdownHandlers}, which composes this with the signal
 * registration so the shutdown logic itself stays unit-testable without
 * crashing the test runner.
 */
export const createShutdown = (
  app: ShutdownableApp,
  otelHandle: OtelBootstrapHandle,
  logger: PinoInstance,
): ShutdownFn => {
  let shutdownPromise: Promise<void> | null = null;

  return (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownPromise) {
      logger.warn({ signal }, 'shutdown already in progress, ignoring signal');
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      logger.info({ signal }, 'shutting down');
      try {
        await app.close();
      } catch (error) {
        logger.error({ err: error }, 'NestJS app.close() failed');
      }
      try {
        await otelHandle.shutdown();
      } catch (error) {
        logger.error({ err: error }, 'OTel SDK shutdown failed');
      }
    })();

    return shutdownPromise;
  };
};

/**
 * Registers `SIGTERM` and `SIGINT` handlers that perform the ordered
 * shutdown sequence and then exit the process.
 *
 * Use this instead of `app.enableShutdownHooks()` — Nest's built-in
 * signal handlers call `app.close()` but do not know about the OTel SDK
 * and exit before exporters drain. This composes `app.close()` with
 * `otel.shutdown()` and only exits after both complete.
 *
 * `OnApplicationShutdown` lifecycle hooks on Nest providers still fire,
 * because they run inside `app.close()` regardless of whether
 * `enableShutdownHooks` was called.
 */
export const registerShutdownHandlers = (
  app: ShutdownableApp,
  otelHandle: OtelBootstrapHandle,
  logger: PinoInstance,
): void => {
  const shutdown = createShutdown(app, otelHandle, logger);

  const handler = (signal: NodeJS.Signals): void => {
    void shutdown(signal).then(() => process.exit(0));
  };

  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);
};
