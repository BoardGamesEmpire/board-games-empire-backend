import { AuditContextService } from '@bge/actor-context';
import { I18nMessage, I18nTranslations, t, translateException } from '@bge/i18n';
import {
  DriverNotRegisteredError,
  InsufficientStorageError,
  StorageMisconfiguredError,
  StorageUnavailableError,
} from '@boardgamesempire/storage-contract';
import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Http } from '@status/codes';
import { I18nService } from 'nestjs-i18n';

/** Seconds advertised in `Retry-After` for retryable storage outages. */
const STORAGE_RETRY_AFTER_SECONDS = 30;

type MappableStorageError =
  StorageUnavailableError | InsufficientStorageError | StorageMisconfiguredError | DriverNotRegisteredError;

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
 * (Nest picks the most specific matching filter), so it renders the marker
 * itself, into the error envelope, via {@link translateException} (#1260, #325).
 * The body carries no `code`: an outage names no specific refusal.
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
    const { status, message } = this.toRefusal(exception, host);
    const refusal = new HttpException(message, status, { cause: exception });

    super.catch(translateException(refusal, this.i18n, this.auditContext), host);
  }

  private toRefusal(
    exception: MappableStorageError,
    host: ArgumentsHost,
  ): { readonly status: number; readonly message: I18nMessage } {
    if (exception instanceof InsufficientStorageError) {
      // Generic localized copy — never the driver's raw message (may leak keys).
      return { status: Http.InsufficientStorage, message: t('errors.storage.insufficient') };
    }

    if (exception instanceof StorageUnavailableError) {
      if (exception.retryable) {
        this.setRetryAfter(host);
      }
      return { status: Http.ServiceUnavailable, message: t('errors.storage.unavailable') };
    }

    // StorageMisconfiguredError | DriverNotRegisteredError: an operator must act
    // (missing/expired backend, unregistered driver slug, #100). 503, logged loud.
    this.logger.error(`Storage misconfiguration (${exception.code}): ${exception.message}`, exception.stack);
    return { status: Http.ServiceUnavailable, message: t('errors.storage.unavailable') };
  }

  private setRetryAfter(host: ArgumentsHost): void {
    const adapter = this.applicationRef ?? this.httpAdapterHost?.httpAdapter;
    adapter?.setHeader?.(host.switchToHttp().getResponse(), 'Retry-After', String(STORAGE_RETRY_AFTER_SECONDS));
  }
}
