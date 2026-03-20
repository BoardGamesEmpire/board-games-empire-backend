/**
 * Static registry of IGDB language records.
 * Source: /languages endpoint — these IDs are stable and enumerable.
 */

export interface IgdbLanguage {
  id: number;
  name: string;
  nativeName: string;
  locale: string;
}

export const IGDB_LANGUAGES: readonly IgdbLanguage[] = [
  { id: 1, name: 'Arabic', nativeName: 'العربية', locale: 'ar' },
  { id: 2, name: 'Chinese (Simplified)', nativeName: '简体中文', locale: 'zh-CN' },
  { id: 3, name: 'Chinese (Traditional)', nativeName: '繁體中文', locale: 'zh-TW' },
  { id: 4, name: 'Czech', nativeName: 'čeština', locale: 'cs-CZ' },
  { id: 5, name: 'Danish', nativeName: 'Dansk', locale: 'da-DK' },
  { id: 6, name: 'Dutch', nativeName: 'Nederlands', locale: 'nl-NL' },
  { id: 7, name: 'English', nativeName: 'English (US)', locale: 'en-US' },
  { id: 8, name: 'English (UK)', nativeName: 'English (UK)', locale: 'en-GB' },
  { id: 9, name: 'Spanish (Spain)', nativeName: 'Español (España)', locale: 'es-ES' },
  { id: 10, name: 'Spanish (Mexico)', nativeName: 'Español (Mexico)', locale: 'es-MX' },
  { id: 11, name: 'Finnish', nativeName: 'Suomi', locale: 'fi-FI' },
  { id: 12, name: 'French', nativeName: 'Français', locale: 'fr-FR' },
  { id: 13, name: 'Hebrew', nativeName: 'עברית', locale: 'he-IL' },
  { id: 14, name: 'Hungarian', nativeName: 'Magyar', locale: 'hu-HU' },
  { id: 15, name: 'Italian', nativeName: 'Italiano', locale: 'it-IT' },
  { id: 16, name: 'Japanese', nativeName: '日本語', locale: 'ja-JP' },
  { id: 17, name: 'Korean', nativeName: '한국어', locale: 'ko-KR' },
  { id: 18, name: 'Norwegian', nativeName: 'Norsk', locale: 'nb-NO' },
  { id: 19, name: 'Polish', nativeName: 'Polski', locale: 'pl-PL' },
  { id: 20, name: 'Portuguese (Portugal)', nativeName: 'Português (Portugal)', locale: 'pt-PT' },
  { id: 21, name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)', locale: 'pt-BR' },
  { id: 22, name: 'Russian', nativeName: 'Русский', locale: 'ru-RU' },
  { id: 23, name: 'Swedish', nativeName: 'Svenska', locale: 'sv-SE' },
  { id: 24, name: 'Turkish', nativeName: 'Türkçe', locale: 'tr-TR' },
  { id: 25, name: 'Thai', nativeName: 'ไทย', locale: 'th-TH' },
  { id: 26, name: 'Vietnamese', nativeName: 'Tiếng Việt', locale: 'vi-VN' },
  { id: 27, name: 'German', nativeName: 'Deutsch', locale: 'de-DE' },
  { id: 28, name: 'Ukrainian', nativeName: 'українська', locale: 'uk-UA' },
] as const;

/**
 * Exact locale → language (e.g. 'en-US' → id 7).
 */
const EXACT_MAP = new Map<string, IgdbLanguage>(IGDB_LANGUAGES.map((lang) => [lang.locale.toLowerCase(), lang]));

/**
 * 2-char language tag → all matching languages (e.g. 'en' → [7, 8]).
 * Built by grouping on the BCP-47 primary subtag (the part before '-').
 */
const PREFIX_MAP = new Map<string, IgdbLanguage[]>();
for (const lang of IGDB_LANGUAGES) {
  const prefix = lang.locale.split('-')[0].toLowerCase();
  const bucket = PREFIX_MAP.get(prefix) ?? [];
  bucket.push(lang);
  PREFIX_MAP.set(prefix, bucket);
}

/**
 * Resolve a locale string to matching IGDB language IDs.
 *
 * Rules:
 *  - A full BCP-47 locale containing '-' (e.g. 'en-US', 'zh-TW') performs an
 *    exact, case-insensitive match. Returns a single-element array or `[]`.
 *  - A bare 2-char language tag (e.g. 'en', 'zh') returns all languages whose
 *    locale starts with that prefix (e.g. 'en' → [7, 8]).
 *  - Unknown locales return `[]`.
 *
 * @example
 * resolveLanguageIds('en-US') // → [7]
 * resolveLanguageIds('en')    // → [7, 8]
 * resolveLanguageIds('zh')    // → [2, 3]
 * resolveLanguageIds('xx')    // → []
 */
export function resolveLanguageIds(locale: string | undefined): number[] {
  if (!locale?.trim()) {
    return [];
  }

  const normalized = locale.trim().toLowerCase();

  if (normalized.includes('-')) {
    const match = EXACT_MAP.get(normalized);
    return match ? [match.id] : [];
  }

  return (PREFIX_MAP.get(normalized) ?? []).map((l) => l.id);
}

/**
 * Resolve multiple locales, returning a deduplicated union of IGDB language IDs.
 * Useful when a caller supplies a priority list (e.g. ['en-US', 'en-GB']).
 *
 * @example
 * resolveLanguageIdList(['en-US', 'fr-FR']) // → [7, 12]
 * resolveLanguageIdList(['en', 'fr'])        // → [7, 8, 12]
 */
export function resolveLanguageIdList(locales: string[]): number[] {
  return [...new Set(locales.flatMap(resolveLanguageIds))];
}
