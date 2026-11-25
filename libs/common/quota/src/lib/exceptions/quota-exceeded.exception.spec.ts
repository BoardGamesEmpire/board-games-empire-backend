import { QuotaScope } from '@bge/database';
import type { I18nPath } from '@bge/i18n';
import { CodedHttpException, t } from '@bge/i18n';
import type { QuotaResource } from '../constants/quota-resource';
import { QUOTA_RESOURCES } from '../constants/quota-resource';
import { QuotaExceededException } from './quota-exceeded.exception';

/**
 * Each resource's key, written out rather than read back from the exception's
 * map, so a swapped entry fails (#1114).
 */
const EXPECTED_MESSAGE: [QuotaResource, I18nPath][] = [
  ['household_member_count', 'errors.quota.exceeded.household_member_count'],
  ['webhook_subscription_count', 'errors.quota.exceeded.webhook_subscription_count'],
  ['storage_bytes', 'errors.quota.exceeded.storage_bytes'],
  ['plugin_install_count', 'errors.quota.exceeded.plugin_install_count'],
  ['household_invite_daily_count', 'errors.quota.exceeded.household_invite_daily_count'],
];

describe('QuotaExceededException', () => {
  it('names the binding quota in a coded envelope, with its bigints as strings (#1260)', () => {
    const exceeded = new QuotaExceededException('storage_bytes', QuotaScope.User, 5n, 5n, 1n);

    expect(exceeded).toBeInstanceOf(CodedHttpException);
    expect(exceeded.getStatus()).toBe(402);
    expect(exceeded.getResponse()).toEqual({
      statusCode: 402,
      error: 'Payment Required',
      message: t('errors.quota.exceeded.storage_bytes'),
      code: 'QUOTA_EXCEEDED',
      resource: 'storage_bytes',
      scope: QuotaScope.User,
      limit: '5',
      currentUsage: '5',
      attemptedAmount: '1',
    });
  });

  it('names a sentence for every quota resource (#1114)', () => {
    expect(EXPECTED_MESSAGE.map(([resource]) => resource).sort()).toEqual([...QUOTA_RESOURCES].sort());
  });

  // Each quota resource gets a whole sentence of its own, with no raw resource
  // name or scope interpolated into it; the fields still name both (#1114).
  it.each(EXPECTED_MESSAGE)('refuses %s with its own sentence and the fields unchanged (#1114)', (resource, key) => {
    const exceeded = new QuotaExceededException(resource, QuotaScope.Household, 10n, 9n, 2n);

    expect(exceeded.getStatus()).toBe(402);
    expect(exceeded.getResponse()).toEqual({
      statusCode: 402,
      error: 'Payment Required',
      message: t(key),
      code: 'QUOTA_EXCEEDED',
      resource,
      scope: QuotaScope.Household,
      limit: '10',
      currentUsage: '9',
      attemptedAmount: '2',
    });
  });

  it('keeps the binding quota on the exception for a caller that reads it (#1260)', () => {
    const exceeded = new QuotaExceededException('storage_bytes', QuotaScope.User, 5n, 5n, 1n);

    expect(exceeded).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      resource: 'storage_bytes',
      scope: QuotaScope.User,
      limit: 5n,
      currentUsage: 5n,
      attemptedAmount: 1n,
    });
  });
});
