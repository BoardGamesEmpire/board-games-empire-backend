import {
  InvalidRequestUrlError,
  OutboundNetworkError,
  RedirectLimitExceededError,
  RedirectToDisallowedTargetError,
  RequestTimeoutError,
  SsrfRejectionError,
} from '@bge/secure-http';
import { WebhookDeliveryFailedError } from '../errors/webhook-delivery-failed.error';
import { classifyDeliveryError, WebhookDeliveryErrorCode } from './classify-delivery-error';

describe('classifyDeliveryError', () => {
  it('classifies a non-2xx delivery response', () => {
    const result = classifyDeliveryError(new WebhookDeliveryFailedError('Delivery d1 to subscription s1 returned 503', 503));
    expect(result.code).toBe(WebhookDeliveryErrorCode.NonSuccessResponse);
  });

  it('classifies a request timeout', () => {
    const result = classifyDeliveryError(new RequestTimeoutError('https://example.com/hook', 5000));
    expect(result.code).toBe(WebhookDeliveryErrorCode.Timeout);
  });

  it('classifies an outbound network error', () => {
    const result = classifyDeliveryError(new OutboundNetworkError('https://example.com/hook', new Error('ECONNRESET')));
    expect(result.code).toBe(WebhookDeliveryErrorCode.NetworkError);
  });

  it.each([
    new SsrfRejectionError('169.254.169.254', 'private-range', '169.254.169.254'),
    new InvalidRequestUrlError('ftp://example.com', 'invalid-scheme'),
    new RedirectToDisallowedTargetError(
      'https://example.com',
      'http://169.254.169.254',
      new SsrfRejectionError('169.254.169.254', 'private-range'),
    ),
    new RedirectLimitExceededError('https://example.com', 5),
  ])('classifies SSRF/URL-policy rejections as BLOCKED_DESTINATION (%#)', (error) => {
    expect(classifyDeliveryError(error).code).toBe(WebhookDeliveryErrorCode.BlockedDestination);
  });

  it('classifies anything unrecognized as UNKNOWN', () => {
    const result = classifyDeliveryError(new Error('duplicate key value violates unique constraint'));
    expect(result.code).toBe(WebhookDeliveryErrorCode.Unknown);
  });

  it('never includes the raw error message or subscriber URL in the sanitized message', () => {
    const secretish = 'connect ECONNREFUSED 10.0.4.12:5432 internal-db.svc.cluster.local';
    const result = classifyDeliveryError(new Error(secretish));

    expect(result.message).not.toContain(secretish);
    expect(JSON.stringify(result)).not.toContain('10.0.4.12');
  });
});
