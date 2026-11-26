import type { ValidationPipeOptions } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { I18nValidationException } from 'nestjs-i18n';

/**
 * A gateway handler's validation. It fails with the `I18nValidationException`
 * `I18nValidationPipe` throws, but always with the raw catalog markers, for
 * `WsErrorFilter` to translate in the frame's locale (#180).
 *
 * `I18nValidationPipe` translates whenever a nestjs-i18n context is open, and
 * on a socket one is open for its first frame only: nestjs-i18n's global
 * interceptor, which Nest runs on frames, keeps the resolved locale on the
 * socket and returns early on every later frame without opening a context. So
 * the same payload would be translated in the pipe on one frame and in the
 * filter on the next, and a copy that fails to render would answer a 500 on
 * the first and the filter's 400 on the rest (#1260).
 */
export class WsValidationPipe extends ValidationPipe {
  constructor(options?: Omit<ValidationPipeOptions, 'exceptionFactory'>) {
    super({ ...options, exceptionFactory: (errors) => new I18nValidationException(errors) });
  }
}
