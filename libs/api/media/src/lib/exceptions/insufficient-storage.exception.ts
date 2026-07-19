import { I18nMessage } from '@bge/i18n';
import { HttpException } from '@nestjs/common';
import { Http } from '@status/codes';

/**
 * 507 Insufficient Storage. NestJS has no built-in exception for this status.
 *
 * `message` may be a deferred {@link I18nMessage} marker (a `t()` result); the
 * edge filter resolves it against the request locale before rendering, exactly
 * as for the standard Nest exceptions.
 */
export class InsufficientStorageException extends HttpException {
  constructor(message: string | I18nMessage = 'Insufficient storage', cause?: unknown) {
    super(message, Http.InsufficientStorage, { cause });
  }
}
