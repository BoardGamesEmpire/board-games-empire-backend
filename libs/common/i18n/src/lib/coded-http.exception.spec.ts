import { t } from '@bge/i18n-core';
import { CodedHttpException } from './coded-http.exception';
import { translateException } from './translate-exception';

describe('CodedHttpException (#1260)', () => {
  const i18n = { translate: jest.fn((key: string) => `t:${key}`) };
  const auditContext = { getLocale: () => 'en' } as never;

  it('builds the envelope with its code and the unrendered marker', () => {
    const marker = t('errors.permission_catalog.entry_changed');

    const thrown = new CodedHttpException(409, 'CATALOG_ENTRY_CHANGED', marker);

    expect(thrown.getStatus()).toBe(409);
    expect(thrown.code).toBe('CATALOG_ENTRY_CHANGED');
    expect(thrown.getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: marker,
      code: 'CATALOG_ENTRY_CHANGED',
    });
  });

  it('carries extra fields, and its code wins over a field named code', () => {
    const body = new CodedHttpException(422, 'CATALOG_ENTRY_REFUSED', t('errors.permission_catalog.entry_refused'), {
      fields: { problems: [], code: 'OTHER' },
    }).getResponse();

    expect(body).toMatchObject({ code: 'CATALOG_ENTRY_REFUSED', problems: [] });
  });

  it('lets no field override the envelope keys', () => {
    const marker = t('errors.permission_catalog.entry_changed');

    const body = new CodedHttpException(409, 'CATALOG_ENTRY_CHANGED', marker, {
      fields: { statusCode: 200, error: 'Custom', message: 'x' },
    }).getResponse();

    expect(body).toEqual({ statusCode: 409, error: 'Conflict', message: marker, code: 'CATALOG_ENTRY_CHANGED' });
  });

  it('names the refusal in its own message, as a whole-body marker does, for a log where no edge renders it (#501)', () => {
    const thrown = new CodedHttpException(
      404,
      'CATALOG_ENTRY_NOT_FOUND',
      t('errors.permission_catalog.entry_not_found', { slug: 'read:game' }),
    );

    expect(thrown.message).toBe('errors.permission_catalog.entry_not_found {"slug":"read:game"}');
  });

  it('keeps its cause', () => {
    const cause = new Error('x');

    const thrown = new CodedHttpException(
      503,
      'MAIL_QUEUE_UNAVAILABLE',
      t('errors.system_settings.mail_queue_unavailable'),
      { cause },
    );

    expect(thrown.cause).toBe(cause);
  });

  it('renders through translateException with every field intact', () => {
    const thrown = new CodedHttpException(422, 'CATALOG_ENTRY_REFUSED', t('errors.permission_catalog.entry_refused'), {
      fields: { problems: [] },
    });

    expect(translateException(thrown, i18n as never, auditContext).getResponse()).toEqual({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 't:errors.permission_catalog.entry_refused',
      code: 'CATALOG_ENTRY_REFUSED',
      problems: [],
    });
  });

  it('refuses a lowercase code at compile time', () => {
    // @ts-expect-error codes are SCREAMING_SNAKE (#1260)
    const lowercase = new CodedHttpException(400, 'catalog_x', t('errors.permission_catalog.edit_empty'));

    expect(lowercase).toBeInstanceOf(CodedHttpException);
  });
});
