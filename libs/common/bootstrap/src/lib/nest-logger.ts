import type { LoggerService } from '@nestjs/common';

/** The slice of a pino instance this adapter needs; structural so tests need no pino. */
export interface PinoLike {
  trace(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  fatal(obj: object, msg?: string): void;
}

type PinoLevel = keyof PinoLike;

/**
 * A Nest log message that carries fields: `msg` becomes the line, the rest
 * become pino fields. This is the contract between `BootstrapService`, which
 * builds one for the boot summary, and the adapter below, which unpacks it.
 */
export interface StructuredLogMessage {
  readonly msg: string;
  readonly [field: string]: unknown;
}

export function structuredLogMessage(message: string, fields?: Record<string, unknown>): string | StructuredLogMessage {
  return fields ? { ...fields, msg: message } : message;
}

/** Nest's own test for a stack argument (`ConsoleLogger.isStackFormat`). */
const STACK_FORMAT = /^(.)+\n\s+at .+:\d+:\d+/;

interface OptionalParams {
  readonly context?: string;
  readonly stack?: string;
}

/**
 * Nest's `error(message, stack?, context?)` convention, read the way its
 * `ConsoleLogger` reads it: with one extra argument, a stack-shaped string is
 * the stack and any other string the context; with more, the last string is
 * the context and the argument before it the stack. Other levels carry only
 * the context. Nest's own `ExceptionHandler` logs a failed module init as
 * `error(message, stack)`, so dropping the stack would lose the one trace
 * that explains a refused boot.
 */
function splitOptionalParams(level: PinoLevel, params: readonly unknown[]): OptionalParams {
  const last = params[params.length - 1];
  const carriesStack = level === 'error' || level === 'fatal';

  if (carriesStack && params.length === 1 && typeof last === 'string' && STACK_FORMAT.test(last)) {
    return { stack: last };
  }

  const context = typeof last === 'string' ? last : undefined;
  if (!carriesStack) return { context };

  const rest = context === undefined ? params : params.slice(0, -1);
  const stack = rest[rest.length - 1];
  return { context, stack: typeof stack === 'string' ? stack : undefined };
}

/**
 * A Nest `LoggerService` over the pino instance `main.ts` already owns, for
 * the standalone bootstrap context (#236). Nest calls these with the
 * message first and the context last; a structured message (`{ msg, ...fields }`)
 * is spread into pino's merging object so the boot summary lands as fields,
 * and a stack rides as pino's `err`.
 */
export function nestLoggerFromPino(pino: PinoLike): LoggerService {
  const emit = (level: PinoLevel, message: unknown, optionalParams: unknown[]): void => {
    const { context, stack } = splitOptionalParams(level, optionalParams);
    const base: Record<string, unknown> = context === undefined ? {} : { context };

    if (message instanceof Error) {
      pino[level]({ ...base, err: message }, message.message);
      return;
    }

    if (stack !== undefined) {
      const text = String(message);
      pino[level]({ ...base, err: { message: text, stack } }, text);
      return;
    }

    if (typeof message === 'object' && message !== null) {
      const { msg, ...fields } = message as StructuredLogMessage;
      pino[level]({ ...base, ...fields }, typeof msg === 'string' ? msg : undefined);
      return;
    }

    pino[level](base, String(message));
  };

  return {
    log: (message: unknown, ...optionalParams: unknown[]) => emit('info', message, optionalParams),
    error: (message: unknown, ...optionalParams: unknown[]) => emit('error', message, optionalParams),
    warn: (message: unknown, ...optionalParams: unknown[]) => emit('warn', message, optionalParams),
    debug: (message: unknown, ...optionalParams: unknown[]) => emit('debug', message, optionalParams),
    verbose: (message: unknown, ...optionalParams: unknown[]) => emit('trace', message, optionalParams),
    fatal: (message: unknown, ...optionalParams: unknown[]) => emit('fatal', message, optionalParams),
  };
}
