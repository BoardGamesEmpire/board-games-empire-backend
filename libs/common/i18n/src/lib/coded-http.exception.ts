import type { I18nMessage } from '@bge/i18n-core';
import { HttpException } from '@nestjs/common';
import { errorEnvelope, type ErrorCode } from './error-envelope';

export interface CodedHttpExceptionOptions {
  /** Machine-readable detail beside the message: a quota's `limit`, a permission catalog refusal's `problems`. */
  readonly fields?: Readonly<Record<string, unknown>>;
  /** Server-side context for logs. It never reaches the response body. */
  readonly cause?: unknown;
}

/**
 * The one way to throw a refusal that names a code (#1260, #822):
 *
 * ```ts
 * throw new CodedHttpException(Http.Conflict, 'CATALOG_ENTRY_CHANGED', t('errors.permission_catalog.entry_changed'));
 * ```
 *
 * Its body is already the error envelope, `{ statusCode, error, message, code,
 * ...fields }`, so no transport has to complete it. The message stays an
 * unrendered marker until the edge filter renders it in the request locale.
 * The code wins over a field named `code`, and the envelope keys win over any
 * field of their name. The `bge/no-uncoded-exception-body` lint rule refuses a
 * `{ code }` body thrown through any other exception class.
 */
export class CodedHttpException extends HttpException {
  constructor(
    status: number,
    readonly code: ErrorCode,
    message: I18nMessage,
    options: CodedHttpExceptionOptions = {},
  ) {
    super(errorEnvelope(status, message, { ...options.fields, code }), status, { cause: options.cause });
  }

  /**
   * Names the refusal in the exception's own `message`: the marker's key and
   * args, as a whole-body marker's exception carries them (#501). Nest reads
   * only a string body `message`, and this body's is the marker, so it would
   * otherwise fall back to the class phrase, "Coded Http Exception", in every
   * log line and stack.
   */
  override initMessage(): void {
    const marker = (this.getResponse() as { readonly message?: { readonly message?: unknown } }).message;

    if (typeof marker?.message === 'string') {
      this.message = marker.message;
      return;
    }

    super.initMessage();
  }
}
