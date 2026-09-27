import { t, type I18nMessage, type I18nPath } from '@bge/i18n';
import { NotFoundException } from '@nestjs/common';

/**
 * Stable, client-facing failure classification for import jobs. Intentionally
 * coarse — just enough for a webhook receiver to distinguish "this input
 * doesn't exist" from "try again later" from "not your fault, ours."
 */
export enum ImportErrorCode {
  NotFound = 'NOT_FOUND',
  GatewayError = 'GATEWAY_ERROR',
  InternalError = 'INTERNAL_ERROR',
  /**
   * The expansion was never attempted because its base game import failed.
   * Not derived from a raw exception — stamped when the base processor cancels
   * expansion rows it can no longer spawn (the expansion is Cancelled, not Failed).
   */
  BaseImportFailed = 'BASE_IMPORT_FAILED',
}

/**
 * English copy for machine-facing surfaces: `Job.result` and the webhook
 * payload, which stays English by policy (see `emit-job-failed.ts`). Must match
 * the `en` catalog text for the same code in {@link FAILURE_MESSAGE_KEY}; a
 * catalog spec checks the pair.
 */
const SAFE_MESSAGE: Record<ImportErrorCode, string> = {
  [ImportErrorCode.NotFound]: 'The requested game could not be found on the gateway.',
  [ImportErrorCode.GatewayError]: 'Fetching game data from the gateway failed.',
  [ImportErrorCode.InternalError]: 'The import failed due to an internal error.',
  [ImportErrorCode.BaseImportFailed]: 'Skipped because the base game import failed.',
};

/**
 * Catalog keys for user-facing surfaces: the status read-back and the
 * ImportFailed notification. Both render in the locale of whoever reads them,
 * when they read them.
 */
const FAILURE_MESSAGE_KEY = {
  [ImportErrorCode.NotFound]: 'errors.game_import.failure.not_found',
  [ImportErrorCode.GatewayError]: 'errors.game_import.failure.gateway_error',
  [ImportErrorCode.InternalError]: 'errors.game_import.failure.internal_error',
  [ImportErrorCode.BaseImportFailed]: 'errors.game_import.failure.base_import_failed',
} as const satisfies Record<ImportErrorCode, I18nPath>;

/**
 * The stable, client-safe message for a classification. Use when constructing a
 * failure result outside the exception path (e.g. cascade cancellation), so the
 * same static, detail-free copy backs every `errorCode`.
 */
export function importErrorMessage(code: ImportErrorCode): string {
  return SAFE_MESSAGE[code];
}

/**
 * The same message as a deferred translation, for a surface a user reads.
 * `I18nResponseInterceptor` renders it in the reader's locale on the way out of
 * an HTTP response. It keeps its brand through a JSON round trip, so it can be
 * stored in a row and rendered each time the row is read back.
 */
export function importErrorMarker(code: ImportErrorCode): I18nMessage {
  return t(FAILURE_MESSAGE_KEY[code]);
}

export interface SanitizedImportError {
  code: ImportErrorCode;
  message: string;
}

/**
 * Which processor observed the failure — resolves the fallback code when the
 * error isn't a recognized NotFoundException.
 */
export type ImportErrorOrigin = 'fetch' | 'persist';

/**
 * Classifies a raw import failure into a stable code + a static, detail-free
 * message safe for a webhook payload sent to a subscriber-controlled URL.
 * Third-party webhook receivers are a fundamentally different trust boundary
 * than our own authenticated surfaces: raw error text here can carry gRPC
 * transport detail (upstream hostnames, ports), Prisma error text (column/
 * table names), or other internal operational detail. The webhook payload,
 * the REST status field, and the ImportFailed notification all carry this
 * sanitized code, with the static message in English (webhook) or translated
 * from the code (the two user-facing surfaces); only the Job.error DB column and
 * operator logs keep the raw text, for debugging via direct infrastructure access.
 */
export function sanitizeImportError(error: unknown, origin: ImportErrorOrigin): SanitizedImportError {
  const code =
    error instanceof NotFoundException
      ? ImportErrorCode.NotFound
      : origin === 'fetch'
        ? ImportErrorCode.GatewayError
        : ImportErrorCode.InternalError;

  return { code, message: SAFE_MESSAGE[code] };
}
