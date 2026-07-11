/**
 * Minimal structural logger — NestJS `Logger` satisfies it — so this helper
 * stays free of a `@nestjs/common` dependency.
 */
interface ErrorLogger {
  error(message: string, stack?: string): void;
}

/**
 * Runs the body of a BullMQ `@OnWorkerEvent` handler (e.g. `onFailed`) so a
 * rejection can never escape and take down the worker.
 *
 * `@nestjs/bullmq` attaches these listeners raw — `worker.on(event, handler)` —
 * and BullMQ emits them synchronously, discarding the promise the handler
 * returns. An async handler that rejects therefore surfaces as an unhandled
 * rejection, which since Node 15 terminates the process, killing every
 * in-flight job on the worker. The handler body is best-effort bookkeeping for
 * a job BullMQ has already settled, so an error there must be logged and
 * swallowed rather than propagated.
 *
 * @param logger  logger the swallowed error is recorded on (NestJS `Logger` fits)
 * @param context short description of the handler, for the log line
 * @param handler the handler body to run
 */
export async function guardWorkerEvent(
  logger: ErrorLogger,
  context: string,
  handler: () => Promise<void>,
): Promise<void> {
  try {
    await handler();
  } catch (error) {
    logger.error(
      `Unhandled error in worker event handler (${context}); swallowed to keep the worker alive`,
      error instanceof Error ? error.stack : String(error),
    );
  }
}
