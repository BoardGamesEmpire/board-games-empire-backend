import { I18N_CATALOG_DIR, type I18nTranslations } from '@bge/i18n-core';
import { Test, type TestingModule } from '@nestjs/testing';
import { I18nModule, I18nService } from 'nestjs-i18n';
import { renderMail } from './render-mail';

describe('renderMail', () => {
  let moduleRef: TestingModule;
  let i18n: I18nService<I18nTranslations>;
  const context = { lang: 'en', serverName: 'Test Server', username: 'sam' };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        I18nModule.forRoot({
          fallbackLanguage: 'en',
          loaderOptions: { path: I18N_CATALOG_DIR, watch: false },
        }),
      ],
    }).compile();
    await moduleRef.init();
    i18n = moduleRef.get(I18nService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  const reset = () =>
    renderMail(
      {
        kind: 'password-reset',
        link: 'https://bge.test/reset?token=abc',
        lifetimeMinutes: 1440,
        expiresAt: '2999-01-01T00:00:00.000Z',
      },
      context,
      i18n,
    );

  it('titles the reset with the server name (#654)', () => {
    expect(reset().subject).toBe('Reset your password on Test Server');
  });

  it('puts the link on a line of its own, with the lifetime, server and username (#654)', () => {
    const { text } = reset();
    expect(text.split('\n')).toContain('https://bge.test/reset?token=abc');
    expect(text).toContain('24 hours');
    expect(text).toContain('Test Server');
    expect(text).toContain('sam');
  });

  it('titles the test email with the server name (#654)', () => {
    expect(renderMail({ kind: 'test' }, context, i18n).subject).toBe('Test email from Test Server');
  });

  it('keeps both messages plain text, with no angle brackets (#654)', () => {
    expect(reset().text).not.toMatch(/[<>]/);
    expect(renderMail({ kind: 'test' }, context, i18n).text).not.toMatch(/[<>]/);
  });
});
