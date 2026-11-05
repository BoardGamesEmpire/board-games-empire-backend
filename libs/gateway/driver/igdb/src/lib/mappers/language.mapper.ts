import * as proto from '@boardgamesempire/proto-gateway';
import { IgdbLanguageEntry } from '../types';

/**
 * Static registry of IGDB language records.
 * Source: /languages endpoint — these IDs are stable and enumerable.
 */

export interface IgdbLanguage {
  id: number;
  name: string;
  nativeName: string;
  locale: string;

  // Canonical BCP 47 tag this IGDB language *means* — the minimal tag that
  // carries the distinction IGDB is making. Region subtags are kept only
  // where IGDB distinguishes variants (en-US vs en-GB); redundant regions
  // are dropped (cs-CZ → cs) and Chinese uses script subtags (zh-Hans).
  ietfTag: string;

  iso6393: string;
  iso6391?: string;
}

export const IGDB_LANGUAGES: readonly IgdbLanguage[] = [
  { id: 1, name: 'Arabic', nativeName: 'العربية', locale: 'ar', ietfTag: 'ar', iso6393: 'ara', iso6391: 'ar' },
  {
    id: 2,
    name: 'Chinese (Simplified)',
    nativeName: '简体中文',
    locale: 'zh-CN',
    ietfTag: 'zh-Hans',
    iso6393: 'zho',
    iso6391: 'zh',
  },
  {
    id: 3,
    name: 'Chinese (Traditional)',
    nativeName: '繁體中文',
    locale: 'zh-TW',
    ietfTag: 'zh-Hant',
    iso6393: 'zho',
    iso6391: 'zh',
  },
  { id: 4, name: 'Czech', nativeName: 'čeština', locale: 'cs-CZ', ietfTag: 'cs', iso6393: 'ces', iso6391: 'cs' },
  { id: 5, name: 'Danish', nativeName: 'Dansk', locale: 'da-DK', ietfTag: 'da', iso6393: 'dan', iso6391: 'da' },
  { id: 6, name: 'Dutch', nativeName: 'Nederlands', locale: 'nl-NL', ietfTag: 'nl', iso6393: 'nld', iso6391: 'nl' },
  {
    id: 7,
    name: 'English (US)',
    nativeName: 'English (US)',
    locale: 'en-US',
    ietfTag: 'en-US',
    iso6393: 'eng',
    iso6391: 'en',
  },
  {
    id: 8,
    name: 'English (UK)',
    nativeName: 'English (UK)',
    locale: 'en-GB',
    ietfTag: 'en-GB',
    iso6393: 'eng',
    iso6391: 'en',
  },
  {
    id: 9,
    name: 'Spanish (Spain)',
    nativeName: 'Español (España)',
    locale: 'es-ES',
    ietfTag: 'es-ES',
    iso6393: 'spa',
    iso6391: 'es',
  },
  {
    id: 10,
    name: 'Spanish (Mexico)',
    nativeName: 'Español (Mexico)',
    locale: 'es-MX',
    ietfTag: 'es-MX',
    iso6393: 'spa',
    iso6391: 'es',
  },
  { id: 11, name: 'Finnish', nativeName: 'Suomi', locale: 'fi-FI', ietfTag: 'fi', iso6393: 'fin', iso6391: 'fi' },
  { id: 12, name: 'French', nativeName: 'Français', locale: 'fr-FR', ietfTag: 'fr', iso6393: 'fra', iso6391: 'fr' },
  { id: 13, name: 'Hebrew', nativeName: 'עברית', locale: 'he-IL', ietfTag: 'he', iso6393: 'heb', iso6391: 'he' },
  { id: 14, name: 'Hungarian', nativeName: 'Magyar', locale: 'hu-HU', ietfTag: 'hu', iso6393: 'hun', iso6391: 'hu' },
  { id: 15, name: 'Italian', nativeName: 'Italiano', locale: 'it-IT', ietfTag: 'it', iso6393: 'ita', iso6391: 'it' },
  { id: 16, name: 'Japanese', nativeName: '日本語', locale: 'ja-JP', ietfTag: 'ja', iso6393: 'jpn', iso6391: 'ja' },
  { id: 17, name: 'Korean', nativeName: '한국어', locale: 'ko-KR', ietfTag: 'ko', iso6393: 'kor', iso6391: 'ko' },
  { id: 18, name: 'Norwegian', nativeName: 'Norsk', locale: 'nb-NO', ietfTag: 'nb', iso6393: 'nor' },
  { id: 19, name: 'Polish', nativeName: 'Polski', locale: 'pl-PL', ietfTag: 'pl', iso6393: 'pol', iso6391: 'pl' },
  {
    id: 20,
    name: 'Portuguese (Portugal)',
    nativeName: 'Português (Portugal)',
    locale: 'pt-PT',
    ietfTag: 'pt-PT',
    iso6393: 'por',
    iso6391: 'pt',
  },
  {
    id: 21,
    name: 'Portuguese (Brazil)',
    nativeName: 'Português (Brasil)',
    locale: 'pt-BR',
    ietfTag: 'pt-BR',
    iso6393: 'por',
    iso6391: 'pt',
  },
  { id: 22, name: 'Russian', nativeName: 'Русский', locale: 'ru-RU', ietfTag: 'ru', iso6393: 'rus', iso6391: 'ru' },
  { id: 23, name: 'Swedish', nativeName: 'Svenska', locale: 'sv-SE', ietfTag: 'sv', iso6393: 'swe', iso6391: 'sv' },
  { id: 24, name: 'Turkish', nativeName: 'Türkçe', locale: 'tr-TR', ietfTag: 'tr', iso6393: 'tur', iso6391: 'tr' },
  { id: 25, name: 'Thai', nativeName: 'ไทย', locale: 'th-TH', ietfTag: 'th', iso6393: 'tha', iso6391: 'th' },
  {
    id: 26,
    name: 'Vietnamese',
    nativeName: 'Tiếng Việt',
    locale: 'vi-VN',
    ietfTag: 'vi',
    iso6393: 'vie',
    iso6391: 'vi',
  },
  { id: 27, name: 'German', nativeName: 'Deutsch', locale: 'de-DE', ietfTag: 'de', iso6393: 'deu', iso6391: 'de' },
  {
    id: 28,
    name: 'Ukrainian',
    nativeName: 'українська',
    locale: 'uk-UA',
    ietfTag: 'uk',
    iso6393: 'ukr',
    iso6391: 'uk',
  },
] as const;

/**
 * Exact locale → language (e.g. 'en-US' → id 7). Indexed by both the IGDB
 * locale ('zh-TW') and the canonical tag ('zh-Hant') so canonical request
 * locales match too.
 */
const EXACT_MAP = new Map<string, IgdbLanguage>(
  IGDB_LANGUAGES.flatMap((lang): [string, IgdbLanguage][] => [
    [lang.locale.toLowerCase(), lang],
    [lang.ietfTag.toLowerCase(), lang],
  ]),
);
const BY_ID = new Map<number, IgdbLanguage>(IGDB_LANGUAGES.map((l) => [l.id, l]));

/**
 * Maps an IGDB language entry to proto LanguageData.
 * Returns null for unknown IDs — callers should filter these out.
 */
export function toLanguageData(igdbLang: IgdbLanguageEntry): proto.LanguageData | null {
  const known = BY_ID.get(igdbLang.id);
  if (!known) {
    return null;
  }

  return {
    ietfTag: known.ietfTag,
    iso6393: known.iso6393,
    iso6391: known.iso6391,
    name: known.name,
  };
}

/**
 * The full registry as ListLanguages interview entries. `value` is the
 * canonical BCP 47 tag — the same value emitted in LanguageData.ietf_tag —
 * so interview-created links resolve import-time data directly.
 */
export function toGatewayLanguageEntries(): proto.GatewayLanguageEntry[] {
  return IGDB_LANGUAGES.map((lang) => ({
    value: lang.ietfTag,
    format: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47,
    ietfTag: lang.ietfTag,
    iso6393: lang.iso6393,
    iso6391: lang.iso6391,
    name: lang.name,
    nativeName: lang.nativeName,
  }));
}

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
