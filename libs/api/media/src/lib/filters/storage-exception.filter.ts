import { AuditContextService } from '@bge/actor-context';
import { I18nTranslations, t, translateException } from '@bge/i18n';
import {
  DriverNotRegisteredError,
  InsufficientStorageError,
  StorageMisconfiguredError,
  StorageUnavailableError,
} from '@boardgamesempire/storage-contract';
import { ArgumentsHost, Catch, HttpException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { I18nService } from 'nestjs-i18n';
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
 *
 * The client-facing copy is a generic, localized `t()` marker — the raw storage
 * error message (which can name internal drivers/keys) is never surfaced; it is
 * kept only as the exception `cause` for server logs. Because this is a
 * controller-scoped filter it runs *instead of* the global `I18nExceptionFilter`
 * (Nest picks the most specific matching filter), so it resolves the marker
 * itself via {@link translateException}.
 */
@Catch(StorageUnavailableError, InsufficientStorageError, StorageMisconfiguredError, DriverNotRegisteredError)
export class StorageExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(StorageExceptionFilter.name);

  constructor(
    private readonly i18n: I18nService<I18nTranslations>,
    private readonly auditContext: AuditContextService,
  ) {
    super();
  }

  override catch(exception: MappableStorageError, host: ArgumentsHost): void {
    super.catch(translateException(this.toHttpException(exception, host), this.i18n, this.auditContext), host);
  }

  private toHttpException(exception: MappableStorageError, host: ArgumentsHost): HttpException {
    if (exception instanceof InsufficientStorageError) {
      // Generic localized copy — never the driver's raw message (may leak keys).
      return new InsufficientStorageException(t('errors.storage.insufficient'), exception);
    }

    if (exception instanceof StorageUnavailableError) {
      if (exception.retryable) {
        this.setRetryAfter(host);
      }
      return new ServiceUnavailableException(t('errors.storage.unavailable'), { cause: exception });
    }

    // StorageMisconfiguredError | DriverNotRegisteredError: an operator must act
    // (missing/expired backend, unregistered driver slug, #100). 503, logged loud.
    this.logger.error(`Storage misconfiguration (${exception.code}): ${exception.message}`, exception.stack);
    return new ServiceUnavailableException(t('errors.storage.unavailable'), { cause: exception });
  }

  private setRetryAfter(host: ArgumentsHost): void {
    const adapter = this.applicationRef ?? this.httpAdapterHost?.httpAdapter;
    adapter?.setHeader?.(host.switchToHttp().getResponse(), 'Retry-After', String(STORAGE_RETRY_AFTER_SECONDS));
  }
}
