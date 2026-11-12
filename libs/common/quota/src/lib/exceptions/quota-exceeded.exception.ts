import type { QuotaScope } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { Http } from '@status/codes';
import type { QuotaResource } from '../constants/quota-resource';

/**
 * Thrown by a write path when `QuotaService.check(...)` returns `allowed:
 * false`. Carries the binding quota so the client knows which one refused it
 * and by how much, beside the code `QUOTA_EXCEEDED` (#1260). Bigints are
 * serialized as strings in the response body.
 *
 * Whether 402 is the right status for a quota is #288's question.
 */
export class QuotaExceededException extends CodedHttpException {
  constructor(
    readonly resource: QuotaResource,
    readonly scope: QuotaScope,
    readonly limit: bigint,
    readonly currentUsage: bigint,
    readonly attemptedAmount: bigint,
  ) {
    super(Http.PaymentRequired, 'QUOTA_EXCEEDED', t('errors.quota.exceeded', { resource, scope }), {
      fields: {
        resource,
        scope,
        limit: limit.toString(),
        currentUsage: currentUsage.toString(),
        attemptedAmount: attemptedAmount.toString(),
      },
    });
  }
}
