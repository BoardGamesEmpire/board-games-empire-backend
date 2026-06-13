import type { INestApplicationContext } from '@nestjs/common';
import type { Logger as PinoInstance } from 'pino';

/**
 * Minimal app surface required for graceful shutdown. Compatible with
 * `INestApplication`, `INestMicroservice`, and `INestApplicationContext`
 * — all three expose `close()` which triggers `OnApplicationShutdown`
 * lifecycle hooks on registered providers.
 */
export type ShutdownableApp = Pick<INestApplicationContext, 'close'>;

/**
 * Async shutdown function returned by {@link createLoggerShutdown}.
 * Calling it more than once returns the in-flight promise rather than
 * re-running the sequence — safe to bind to multiple process signals.
 */
export type LoggerShutdownFn = (signal: NodeJS.Signals) => Promise<void>;

/**
 * Drains pino's underlying stream (and, where applicable, the
 * `ThreadStream` backing a transport-configured logger). Wrapped in
 * a Promise so callers can await the flush deterministically. The
 * callback signature `(err?: Error) => void` is the pino public
 * surface; we surface any flush error to the caller rather than
 * swallowing it so {@link createLoggerShutdown} can log it.
 */
const flushLogger = (logger: PinoInstance): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    logger.flush((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

/**
 * Builds an idempotent async shutdown function that closes the Nest
 * app BEFORE flushing the pino logger.
 *
 * The ordering matches `@bge/otel`'s `createShutdown`: `app.close()`
 * runs every `OnApplicationShutdown` provider, which is the moment
 * those providers produce their final log lines (Redis quit, BullMQ
 * disconnect, etc.). The logger flush happens AFTER so the trailing
 * batch reaches the destination rather than being lost when the
 * process exits.
 *
 * Both `app.close()` and the logger flush log errors via the supplied
 * logger but do NOT abort the sequence — graceful shutdown is
 * best-effort flush, not strict correctness.
 *
 * Re-entrancy: the function caches its promise on first invocation.
 * Subsequent calls with any signal log a warning and return the
 * cached promise, preventing the sequence from running twice on
 * rapid SIGTERM / SIGINT.
 *
 * Note that this function does NOT call `process.exit` — that lives
 * in {@link registerLoggerShutdown}, which composes this with signal
 * registration so the shutdown logic itself stays unit-testable
 * without crashing the test runner.
 */
export const createLoggerShutdown = (app: ShutdownableApp, logger: PinoInstance): LoggerShutdownFn => {
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
        await flushLogger(logger);
      } catch (error) {
        // Best-effort: there is no reliable way to surface a flush
        // failure once the logger itself can't be trusted, but we
        // attempt one final write through the same instance.
        logger.error({ err: error }, 'pino logger flush failed');
      }
    })();

    return shutdownPromise;
  };
};

/**
 * Registers `SIGTERM` and `SIGINT` handlers that perform the ordered
 * shutdown sequence and then exit the process.
 *
 * Intended for services that bootstrap pino via `@bge/logger` but do
 * NOT participate in the OpenTelemetry pipeline — currently the BGG
 * and IGDB game gateways. OTel-enabled apps continue to use
 * `registerShutdownHandlers` from `@bge/otel`, which additionally
 * drains the trace exporter.
 *
 * Use this instead of `app.enableShutdownHooks()` — Nest's built-in
 * signal handlers call `app.close()` but exit before the pino
 * worker-thread transport drains, dropping the trailing batch of
 * log records. `OnApplicationShutdown` lifecycle hooks on Nest
 * providers still fire because they run inside `app.close()`.
 */
export const registerLoggerShutdown = (app: ShutdownableApp, logger: PinoInstance): void => {
  const shutdown = createLoggerShutdown(app, logger);

  const handler = (signal: NodeJS.Signals): void => {
    void shutdown(signal)
      .catch((err) => logger.error({ err }, 'unexpected shutdown failure'))
      .finally(() => process.exit(0));
  };

  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);
};
