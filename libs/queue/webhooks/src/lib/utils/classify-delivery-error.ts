import { SafeHttpError } from '@bge/secure-http';
import { WebhookDeliveryFailedError } from '../errors/webhook-delivery-failed.error';

/**
 * Stable, subscriber-facing classification for a webhook delivery failure.
 * Deliberately coarse — enough to tell "your endpoint is unreachable" from
 * "your endpoint returned an error status" from "something went wrong on our
 * end," without echoing implementation detail.
 */
export enum WebhookDeliveryErrorCode {
  NonSuccessResponse = 'NON_SUCCESS_RESPONSE',
  Timeout = 'TIMEOUT',
  NetworkError = 'NETWORK_ERROR',
  BlockedDestination = 'BLOCKED_DESTINATION',
  Unknown = 'UNKNOWN',
}

const SAFE_MESSAGE: Record<WebhookDeliveryErrorCode, string> = {
  [WebhookDeliveryErrorCode.NonSuccessResponse]: 'The webhook endpoint returned a non-success response.',
  [WebhookDeliveryErrorCode.Timeout]: 'The webhook endpoint did not respond in time.',
  [WebhookDeliveryErrorCode.NetworkError]: 'A network error occurred while contacting the webhook endpoint.',
  [WebhookDeliveryErrorCode.BlockedDestination]: 'The webhook endpoint URL is not reachable due to security policy.',
  [WebhookDeliveryErrorCode.Unknown]: 'Webhook delivery failed due to an internal error.',
};

export interface ClassifiedDeliveryError {
  code: WebhookDeliveryErrorCode;
  message: string;
}

/**
 * Classifies a delivery failure into a stable code + static message.
 *
 * Nothing currently persists or delivers `lastError` anywhere reachable by
 * the subscription owner or a third party — there is no DB column for it and
 * `WEBHOOK_DISABLED_EVENT` has no registered listener today. This exists so
 * that the moment either lands (an in-app "your webhook was disabled"
 * notification is the obvious next feature, mirroring NotificationListener
 * elsewhere), the raw `Error` — which for SafeHttpService failures already
 * carries the subscriber's own URL/resolved IP, and for anything else could
 * carry arbitrary internal detail (encryption, DB, a bug) — never flows
 * through by default. The full raw error remains in server logs only, via
 * the caller's own `logger.warn`/`logger.error` calls.
 */
export function classifyDeliveryError(error: unknown): ClassifiedDeliveryError {
  const code = toErrorCode(error);
  return { code, message: SAFE_MESSAGE[code] };
}

function toErrorCode(error: unknown): WebhookDeliveryErrorCode {
  if (error instanceof WebhookDeliveryFailedError) {
    return WebhookDeliveryErrorCode.NonSuccessResponse;
  }

  if (error instanceof SafeHttpError) {
    switch (error.code) {
      case 'REQUEST_TIMEOUT':
        return WebhookDeliveryErrorCode.Timeout;
      case 'OUTBOUND_NETWORK_ERROR':
        return WebhookDeliveryErrorCode.NetworkError;
      case 'SSRF_REJECTION':
      case 'INVALID_REQUEST_URL':
      case 'REDIRECT_DENIED':
      case 'REDIRECT_LIMIT_EXCEEDED':
        return WebhookDeliveryErrorCode.BlockedDestination;
    }
  }

  return WebhookDeliveryErrorCode.Unknown;
}
