import {
  DriverNotRegisteredError,
  InsufficientStorageError,
  StorageMisconfiguredError,
  StorageUnavailableError,
} from '@boardgamesempire/storage-contract';
import { ArgumentsHost, Catch, Logger, ServiceUnavailableException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { InsufficientStorageException } from '../exceptions/insufficient-storage.exception';

/** Seconds advertised in `Retry-After` for retryable storage outages. */
const STORAGE_RETRY_AFTER_SECONDS = 30;

type MappableStorageError =
  | StorageUnavailableError
  | InsufficientStorageError
  | StorageMisconfiguredError
  | DriverNotRegisteredError;

/**
 * Translates the storage failure vocabulary into HTTP statuses, mirroring
 * MulterExceptionFilter: map only the cases we own, delegate the rest to the
 * base filter. Catches just the four mappable subtypes, so a deliberate
 * ObjectNotFound/Signature mapping done inside a service (already a Nest
 * exception by the time it reaches here) is never intercepted.
 *
 *   StorageUnavailableError(retryable)  -> 503 + Retry-After
 *   StorageUnavailableError(!retryable) -> 503
 *   InsufficientStorageError            -> 507
 *   StorageMisconfiguredError           -> 503, logged critical
 *   DriverNotRegisteredError            -> 503, logged critical (#100)
 */
@Catch(StorageUnavailableError, InsufficientStorageError, StorageMisconfiguredError, DriverNotRegisteredError)
export class StorageExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(StorageExceptionFilter.name);

  override catch(exception: MappableStorageError, host: ArgumentsHost): void {
    super.catch(this.toHttpException(exception, host), host);
  }

  private toHttpException(exception: MappableStorageError, host: ArgumentsHost) {
    if (exception instanceof InsufficientStorageError) {
      return new InsufficientStorageException(exception.message, exception);
    }

    if (exception instanceof StorageUnavailableError) {
      if (exception.retryable) {
        this.setRetryAfter(host);
      }
      return new ServiceUnavailableException('Storage temporarily unavailable', { cause: exception });
    }

    // StorageMisconfiguredError | DriverNotRegisteredError: an operator must act
    // (missing/expired backend, unregistered driver slug, #100). 503, logged loud.
    this.logger.error(`Storage misconfiguration (${exception.code}): ${exception.message}`, exception.stack);
    return new ServiceUnavailableException('Storage temporarily unavailable', { cause: exception });
  }

  private setRetryAfter(host: ArgumentsHost): void {
    const adapter = this.applicationRef ?? this.httpAdapterHost?.httpAdapter;
    adapter?.setHeader?.(host.switchToHttp().getResponse(), 'Retry-After', String(STORAGE_RETRY_AFTER_SECONDS));
  }
}
