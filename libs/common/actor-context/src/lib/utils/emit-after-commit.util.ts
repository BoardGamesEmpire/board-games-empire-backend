import type { LoggerService } from '@nestjs/common';

/** What {@link emitAfterCommit} needs of the bus: `EventEmitter2`'s `emit`. */
export interface AfterCommitEmitter {
  emit(event: string, ...values: unknown[]): boolean;
}

/**
 * Emits one payload, a domain event or a webhook envelope, for a change that
 * has already committed, and logs a listener's throw instead of rethrowing it
 * (#245). Every lib that publishes after commit emits through this, so the
 * guard and its log shape live in one place.
 *
 * `EventEmitterModule` runs without `ignoreErrors`, so a listener registered
 * on the emitter itself (`onAny`, as the audit persistence listener is) that
 * throws synchronously propagates out of `emit()`. The caller usually sits
 * inside its mutation's try block, so the throw would be answered as a 500
 * for a change that committed, and a retry would meet a refusal. A listener
 * declared with `@OnEvent` never reaches the guard: Nest wraps it and logs
 * its failure. Such a listener's rejected promise is its own to catch.
 *
 * Logged rather than swallowed: a lost audit entry or delivery is a real
 * problem, just not one the caller can act on or retry away. The log names
 * `name`, so it says which emit was lost, and `about`, the change it was for.
 *
 * The error's message goes in the log string and its stack as a string second
 * argument, Nest's `(message, stack)` contract: nestjs-pino maps that to
 * `err`, but hands an `Error` object to pino as a printf argument, which drops
 * it when the message has no placeholder.
 */
export function emitAfterCommit(
  emitter: AfterCommitEmitter,
  logger: Pick<LoggerService, 'error'>,
  name: string,
  payload: unknown,
  about: string,
): void {
  try {
    emitter.emit(name, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const summary = `A listener failed for ${name} (${about}) after the change committed: ${message}`;

    if (stack === undefined) {
      logger.error(summary);
    } else {
      logger.error(summary, stack);
    }
  }
}
