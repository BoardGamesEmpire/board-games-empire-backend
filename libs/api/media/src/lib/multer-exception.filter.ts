import { AuditContextService } from '@bge/actor-context';
import { I18nTranslations, t, translateException } from '@bge/i18n';
import { ArgumentsHost, BadRequestException, Catch, PayloadTooLargeException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { MulterError } from 'multer';
import { I18nService } from 'nestjs-i18n';
import { MAX_UPLOAD_BYTES } from './media-mime.policy';

/**
 * Maps Multer's own limit errors (thrown inside the file interceptor, before the
 * handler runs) to proper HTTP statuses. Scoped narrowly to `MulterError`, so
 * every other exception raised on the controller — a service `t()` marker, a
 * validation error — falls through to the global i18n filters unchanged rather
 * than being swallowed by a catch-all. The two client-facing strings are
 * localized `t()` markers; because this filter renders the response itself it
 * resolves them via {@link translateException} (the global filter never runs
 * once a controller-scoped filter matches).
 */
@Catch(MulterError)
export class MulterExceptionFilter extends BaseExceptionFilter {
  constructor(
    private readonly i18n: I18nService<I18nTranslations>,
    private readonly auditContext: AuditContextService,
  ) {
    super();
  }

  override catch(exception: MulterError, host: ArgumentsHost): void {
    const mapped =
      exception.code === 'LIMIT_FILE_SIZE'
        ? new PayloadTooLargeException(t('errors.upload.too_large', { maxBytes: MAX_UPLOAD_BYTES }))
        : new BadRequestException(t('errors.upload.invalid'));

    super.catch(translateException(mapped, this.i18n, this.auditContext), host);
  }
}
