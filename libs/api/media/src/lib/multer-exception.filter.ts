import { ArgumentsHost, BadRequestException, Catch, PayloadTooLargeException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { MAX_UPLOAD_BYTES } from './media-mime.policy';

interface MulterLikeError {
  name: string;
  code?: string;
}

// Duck-typed to avoid an @types/multer dependency for one branch.
function isMulterError(error: unknown): error is MulterLikeError {
  return (error as MulterLikeError)?.name === 'MulterError';
}

/** Maps Multer limit errors (thrown inside the file interceptor, before the
 *  handler runs) to proper HTTP statuses; delegates everything else. */
@Catch()
export class MulterExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (isMulterError(exception)) {
      const mapped =
        exception.code === 'LIMIT_FILE_SIZE'
          ? new PayloadTooLargeException(`File exceeds the ${MAX_UPLOAD_BYTES}-byte limit`)
          : new BadRequestException('Invalid file upload');

      return super.catch(mapped, host);
    }

    return super.catch(exception, host);
  }
}
