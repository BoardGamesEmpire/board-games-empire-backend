import { QuotaScope } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { QuotaExceededException } from './quota-exceeded.exception';

describe('QuotaExceededException', () => {
  it('names the binding quota in a coded envelope, with its bigints as strings (#1260)', () => {
    const exceeded = new QuotaExceededException('storage_bytes', QuotaScope.User, 5n, 5n, 1n);

    expect(exceeded).toBeInstanceOf(CodedHttpException);
    expect(exceeded.getStatus()).toBe(402);
    expect(exceeded.getResponse()).toEqual({
      statusCode: 402,
      error: 'Payment Required',
      message: t('errors.quota.exceeded', { resource: 'storage_bytes', scope: QuotaScope.User }),
      code: 'QUOTA_EXCEEDED',
      resource: 'storage_bytes',
      scope: QuotaScope.User,
      limit: '5',
      currentUsage: '5',
      attemptedAmount: '1',
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
