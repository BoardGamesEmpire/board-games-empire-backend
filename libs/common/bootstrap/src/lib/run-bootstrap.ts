import type { LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { BootstrapModuleOptions } from './bootstrap-options';
import { BootstrapModule } from './bootstrap.module';
import { BootstrapService } from './bootstrap.service';
import type { BootstrapSummary } from './runner';

export interface RunBootstrapOptions extends BootstrapModuleOptions {
  /** Where the sequence logs; `nestLoggerFromPino(bootstrapLogger)` in every `main.ts`. */
  readonly logger: LoggerService;
}

/**
 * What every `main.ts` calls before creating its application: a throwaway
 * Nest context, the sequence, and a clean close so no connection outlives it
 * (#236). Throws when the sequence refuses; the caller's existing
 * bootstrap failure path logs and exits.
 */
export async function runBootstrap(options: RunBootstrapOptions): Promise<BootstrapSummary> {
  const { logger, ...moduleOptions } = options;
  // `abortOnError: false`: Nest's default answer to a failed module init is
  // `process.abort()`, which would skip the `finally` below and the caller's
  // failure path alike. Rethrowing is what lets the doc comment above hold.
  const context = await NestFactory.createApplicationContext(BootstrapModule.forRoot(moduleOptions), {
    logger,
    abortOnError: false,
  });

  try {
    return await context.get(BootstrapService).run();
  } finally {
    await context.close();
  }
}
