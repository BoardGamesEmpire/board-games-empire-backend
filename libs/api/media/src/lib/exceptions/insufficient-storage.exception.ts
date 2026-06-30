import { HttpException } from '@nestjs/common';
import { Http } from '@status/codes';

/**
 * 507 Insufficient Storage. NestJS has no built-in exception for this status.
 */
export class InsufficientStorageException extends HttpException {
  constructor(message = 'Insufficient storage', cause?: unknown) {
    super(message, Http.InsufficientStorage, { cause });
  }
}
