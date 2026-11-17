import { PluginConsentActLocaleError } from '@bge/plugin';
import { consentActLocale } from './consent-act-locale';

describe('consentActLocale (#1301)', () => {
  it('renders in the locale the body names when the server supports it, whatever the request resolved', () => {
    expect(consentActLocale('de', ['en', 'de'], 'en')).toBe('de');
  });

  it("keeps the request's own locale when the body names none", () => {
    expect(consentActLocale(undefined, ['en'], 'en')).toBe('en');
    expect(consentActLocale(undefined, ['en'], undefined)).toBeUndefined();
    // The body's @IsOptional() lets a JSON null through; it names no locale.
    expect(consentActLocale(null, ['en'], 'en')).toBe('en');
  });

  it('refuses a locale the server does not support, naming it', () => {
    const refusal = (() => {
      try {
        consentActLocale('xx', ['en'], 'en');
      } catch (error) {
        return error;
      }

      return undefined;
    })();

    expect(refusal).toBeInstanceOf(PluginConsentActLocaleError);
    expect(refusal).toMatchObject({ name: 'PluginConsentActLocaleError', locale: 'xx' });
  });

  // The client sends the locale the consent surface was requested in, one of
  // the locales this server supports, never the `locale` a reason reports
  // (the key of the plugin's own text). The supported tags are the server's
  // own spelling, so the match is exact.
  it('matches the supported tags exactly', () => {
    expect(() => consentActLocale('EN', ['en'], 'en')).toThrow(PluginConsentActLocaleError);
  });
});
