/**
 * Catalog locale used when nothing else resolves: the `nestjs-i18n`
 * `fallbackLanguage`, the final step of the request-time resolver chain, and
 * the locale the supported-set falls back to when the DB and the shipped
 * catalogs disagree entirely. Must always name a shipped catalog folder
 * (`libs/common/i18n/src/lib/i18n/<locale>`) — see
 * docs/i18n/locale-key-strategy.md.
 */
export const FALLBACK_LOCALE = 'en' as const;
