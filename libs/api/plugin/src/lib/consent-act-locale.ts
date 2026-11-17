import { PluginConsentActLocaleError } from '@bge/plugin';

/**
 * The locale an act renders its stored presentation in (#1301): the one the
 * body names, when the server supports it; else the request's own.
 *
 * A consent act records the text the consent surface showed, and the surface
 * was rendered by an earlier request whose locale can differ from this one's.
 * The client sends the locale that consent surface was requested in, which
 * must be one of the locales this server supports. It is not the `locale` a
 * reason reports: that names the key of the plugin's own text the reason came
 * from, which need not be a locale this server supports. The match is exact,
 * because the supported tags are the server's own spelling.
 *
 * `named` admits null because the body's `@IsOptional()` lets a JSON null
 * through, and a null names no locale.
 *
 * @throws PluginConsentActLocaleError when `named` is present and not supported.
 */
export function consentActLocale(
  named: string | null | undefined,
  supported: readonly string[],
  requestLocale: string | undefined,
): string | undefined {
  if (named === undefined || named === null) {
    return requestLocale;
  }

  if (!supported.includes(named)) {
    throw new PluginConsentActLocaleError(named);
  }

  return named;
}
