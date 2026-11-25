import type { QuotaScope } from '@bge/database';
import type { I18nPath } from '@bge/i18n';
import { CodedHttpException, t } from '@bge/i18n';
import { Http } from '@status/codes';
import type { QuotaResource } from '../constants/quota-resource';

/**
 * The refusal's message per quota resource: a whole sentence for each, rather
 * than the raw resource name and scope interpolated into one frame. The fields
 * still carry `resource` and `scope` for a client that branches on them (#1114).
 */
const QUOTA_EXCEEDED_MESSAGE = {
  household_member_count: 'errors.quota.exceeded.household_member_count',
  webhook_subscription_count: 'errors.quota.exceeded.webhook_subscription_count',
  storage_bytes: 'errors.quota.exceeded.storage_bytes',
  plugin_install_count: 'errors.quota.exceeded.plugin_install_count',
  household_invite_daily_count: 'errors.quota.exceeded.household_invite_daily_count',
  event_invite_daily_count: 'errors.quota.exceeded.event_invite_daily_count',
} as const satisfies Record<QuotaResource, I18nPath>;

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
    super(Http.PaymentRequired, 'QUOTA_EXCEEDED', t(QUOTA_EXCEEDED_MESSAGE[resource]), {
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
