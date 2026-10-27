import type { LoggerService } from '@nestjs/common';
import type { BetterAuthOptions } from 'better-auth';

type BetterAuthLogger = NonNullable<BetterAuthOptions['logger']>;
type BetterAuthLevel = Parameters<NonNullable<BetterAuthLogger['log']>>[0];
type NestLevel = 'debug' | 'log' | 'warn' | 'error';

const NEST_LEVEL: Record<BetterAuthLevel, NestLevel> = {
  debug: 'debug',
  info: 'log',
  warn: 'warn',
  error: 'error',
};

/**
 * Routes better-auth's own log lines through the process logger (#627).
 * Left alone, better-auth writes coloured console lines in its own format at
 * its own level, so an error is not one pino record and `LOG_LEVEL` does not
 * govern it.
 *
 * better-auth filters on its own `level` before it calls `log`, and its
 * default is `warn`. Keeping it there makes this change format-only: the same
 * lines as before, now one pino record each, with `LOG_LEVEL` still filtering
 * what passes. A lower threshold would forward info lines that carry personal
 * data, such as the email in "Sign-up attempt for existing email", and
 * production would print them.
 *
 * nestjs-pino merges an object message into the record's fields: `msg` stays
 * the message and an `err` Error is serialized with its stack.
 */
export function betterAuthLogger(nest: Pick<LoggerService, 'debug' | 'log' | 'warn' | 'error'>): BetterAuthLogger {
  return {
    level: 'warn',
    log(level, message, ...args) {
      const errorIndex = args.findIndex((arg) => arg instanceof Error);
      const err = errorIndex === -1 ? undefined : args[errorIndex];
      const rest = errorIndex === -1 ? args : args.filter((_, index) => index !== errorIndex);

      nest[NEST_LEVEL[level]]?.({
        msg: message,
        ...(err ? { err } : {}),
        ...(rest.length ? { args: rest } : {}),
      });
    },
  };
}
