import { HttpException, NotFoundException } from '@nestjs/common';
import { t } from './translatable';
import { translateException } from './translate-exception';

describe('translateException', () => {
  let translate: jest.Mock;
  let i18n: { translate: jest.Mock };
  const auditContext = { getLocale: () => 'en' } as never;

  beforeEach(() => {
    translate = jest.fn((key: string) => `t:${key}`);
    i18n = { translate };
  });

  it('translates a whole-body marker into the standard { statusCode, message, error } shape', () => {
    const rebuilt = translateException(
      new NotFoundException(t('errors.language.not_found', { id: '42' })),
      i18n as never,
      auditContext,
    );

    expect(translate).toHaveBeenCalledWith('errors.language.not_found', { lang: 'en', args: { id: '42' } });
    expect(rebuilt.getStatus()).toBe(404);
    expect(rebuilt.getResponse()).toEqual({
      statusCode: 404,
      message: 't:errors.language.not_found',
      error: 'Not Found',
    });
  });

  it('translates only the `message` field of a structured body, preserving sibling fields, status, and error label', () => {
    // Shape mirrors QuotaExceededException: machine-readable fields alongside a
    // translatable message marker, under a non-default `error` label and 402.
    const original = new HttpException(
      {
        statusCode: 402,
        error: 'Quota Exceeded',
        message: t('errors.quota.exceeded', { resource: 'storage_bytes', scope: 'User' }),
        resource: 'storage_bytes',
        scope: 'User',
        limit: '100',
        currentUsage: '100',
        attemptedAmount: '1',
      },
      402,
    );

    const rebuilt = translateException(original, i18n as never, auditContext);

    expect(translate).toHaveBeenCalledWith('errors.quota.exceeded', {
      lang: 'en',
      args: { resource: 'storage_bytes', scope: 'User' },
    });
    expect(rebuilt.getStatus()).toBe(402);
    // The message is rendered; every other field (and the custom error label) survives.
    expect(rebuilt.getResponse()).toEqual({
      statusCode: 402,
      error: 'Quota Exceeded',
      message: 't:errors.quota.exceeded',
      resource: 'storage_bytes',
      scope: 'User',
      limit: '100',
      currentUsage: '100',
      attemptedAmount: '1',
    });
  });

  it('preserves the original cause across the re-issue', () => {
    const cause = new Error('raw driver error');
    const original = new HttpException(t('errors.storage.unavailable'), 503, { cause });

    const rebuilt = translateException(original, i18n as never, auditContext);

    expect((rebuilt as unknown as { cause?: unknown }).cause).toBe(cause);
  });

  it('returns a non-marker exception untouched (same reference)', () => {
    const plain = new NotFoundException('plain english message');

    const result = translateException(plain, i18n as never, auditContext);

    expect(result).toBe(plain);
    expect(translate).not.toHaveBeenCalled();
  });

  it('leaves a structured body whose `message` is a plain string untouched', () => {
    const plain = new HttpException({ statusCode: 402, message: 'not a marker', resource: 'x' }, 402);

    const result = translateException(plain, i18n as never, auditContext);

    expect(result).toBe(plain);
    expect(translate).not.toHaveBeenCalled();
  });
});
