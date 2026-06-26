import * as proto from '@boardgamesempire/proto-gateway';
import { BggLinkType } from '../constants';
import type { BggLink } from '../types';

/**
 * Internal mapping from BGG language display names to canonical ISO
 * codes. BGG language values are English display names ("Afrikaans",
 * "German", "Korean"); this map resolves them to ISO 639-3 + 639-1.
 *
 * Coverage: the ~40 languages most commonly tagged on BGG releases.
 * Unknown languages are dropped at the mapper level — they would be
 * dropped by the import worker anyway (Language.findUnique by code).
 *
 * This map is gateway-internal. A future LanguageGatewayLink table will
 * replace it with a DB-backed lookup populated during gateway onboarding.
 */
interface BggLanguage {
  readonly iso6393: string;
  readonly iso6391?: string;
  readonly name: string;
}

const BGG_LANGUAGE_MAP: Readonly<Record<string, BggLanguage>> = {
  Afrikaans: { iso6393: 'afr', iso6391: 'af', name: 'Afrikaans' },
  Arabic: { iso6393: 'ara', iso6391: 'ar', name: 'Arabic' },
  Bulgarian: { iso6393: 'bul', iso6391: 'bg', name: 'Bulgarian' },
  Catalan: { iso6393: 'cat', iso6391: 'ca', name: 'Catalan' },
  Chinese: { iso6393: 'zho', iso6391: 'zh', name: 'Chinese' },
  Croatian: { iso6393: 'hrv', iso6391: 'hr', name: 'Croatian' },
  Czech: { iso6393: 'ces', iso6391: 'cs', name: 'Czech' },
  Danish: { iso6393: 'dan', iso6391: 'da', name: 'Danish' },
  Dutch: { iso6393: 'nld', iso6391: 'nl', name: 'Dutch' },
  English: { iso6393: 'eng', iso6391: 'en', name: 'English' },
  Estonian: { iso6393: 'est', iso6391: 'et', name: 'Estonian' },
  Finnish: { iso6393: 'fin', iso6391: 'fi', name: 'Finnish' },
  French: { iso6393: 'fra', iso6391: 'fr', name: 'French' },
  German: { iso6393: 'deu', iso6391: 'de', name: 'German' },
  Greek: { iso6393: 'ell', iso6391: 'el', name: 'Greek' },
  Hebrew: { iso6393: 'heb', iso6391: 'he', name: 'Hebrew' },
  Hungarian: { iso6393: 'hun', iso6391: 'hu', name: 'Hungarian' },
  Indonesian: { iso6393: 'ind', iso6391: 'id', name: 'Indonesian' },
  Italian: { iso6393: 'ita', iso6391: 'it', name: 'Italian' },
  Japanese: { iso6393: 'jpn', iso6391: 'ja', name: 'Japanese' },
  Korean: { iso6393: 'kor', iso6391: 'ko', name: 'Korean' },
  Latvian: { iso6393: 'lav', iso6391: 'lv', name: 'Latvian' },
  Lithuanian: { iso6393: 'lit', iso6391: 'lt', name: 'Lithuanian' },
  Norwegian: { iso6393: 'nor', iso6391: 'no', name: 'Norwegian' },
  Polish: { iso6393: 'pol', iso6391: 'pl', name: 'Polish' },
  Portuguese: { iso6393: 'por', iso6391: 'pt', name: 'Portuguese' },
  Romanian: { iso6393: 'ron', iso6391: 'ro', name: 'Romanian' },
  Russian: { iso6393: 'rus', iso6391: 'ru', name: 'Russian' },
  Serbian: { iso6393: 'srp', iso6391: 'sr', name: 'Serbian' },
  Slovak: { iso6393: 'slk', iso6391: 'sk', name: 'Slovak' },
  Slovenian: { iso6393: 'slv', iso6391: 'sl', name: 'Slovenian' },
  Spanish: { iso6393: 'spa', iso6391: 'es', name: 'Spanish' },
  Swedish: { iso6393: 'swe', iso6391: 'sv', name: 'Swedish' },
  Thai: { iso6393: 'tha', iso6391: 'th', name: 'Thai' },
  Turkish: { iso6393: 'tur', iso6391: 'tr', name: 'Turkish' },
  Ukrainian: { iso6393: 'ukr', iso6391: 'uk', name: 'Ukrainian' },
  Vietnamese: { iso6393: 'vie', iso6391: 'vi', name: 'Vietnamese' },
};

/**
 * Reverse lookup by 2-char tag — used by `resolveLocaleLanguageNames`
 * to pick BGG language names from a request locale.
 */
const BY_ISO_639_1: ReadonlyMap<string, BggLanguage> = new Map(
  Object.values(BGG_LANGUAGE_MAP)
    .filter((lang): lang is BggLanguage & { iso6391: string } => lang.iso6391 !== undefined)
    .map((lang) => [lang.iso6391, lang]),
);

/**
 * Resolve a single BGG language link to proto LanguageData.
 * Returns null when the language name is not in the internal map.
 */
export function toLanguageData(link: BggLink): proto.LanguageData | null {
  if (link.type !== BggLinkType.Language) {
    return null;
  }

  const known = BGG_LANGUAGE_MAP[link.value];
  if (!known) {
    return null;
  }

  return {
    iso6393: known.iso6393,
    iso6391: known.iso6391,
    name: known.name,
  } satisfies proto.LanguageData;
}

/**
 * Filter and dedupe a link array down to recognized language entries.
 * Deduplication happens on iso6393 — multilingual editions sometimes
 * carry duplicate language links.
 */
export function toLanguageDataList(links: readonly BggLink[]): proto.LanguageData[] {
  const seen = new Set<string>();
  const result: proto.LanguageData[] = [];

  for (const link of links) {
    const mapped = toLanguageData(link);
    if (mapped && !seen.has(mapped.iso6393)) {
      seen.add(mapped.iso6393);
      result.push(mapped);
    }
  }

  return result;
}

/**
 * Resolve a request locale (BCP 47-style "en", "en-US", "de-DE") to the
 * BGG language display name(s) it should match. Used by the
 * resolver to pick a locale-appropriate edition.
 *
 * Returns an empty array when the locale's language subtag is unknown.
 */
export function resolveLocaleLanguageNames(locale: string | undefined): string[] {
  if (!locale?.trim()) {
    return [];
  }

  const tag = locale.split('-')[0]?.toLowerCase();
  if (!tag) {
    return [];
  }

  const known = BY_ISO_639_1.get(tag);
  return known ? [known.name] : [];
}
