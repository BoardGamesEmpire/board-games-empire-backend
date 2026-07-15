/**
 * IETF BCP 47 language-tag utilities built on Node's full-ICU `Intl`
 * primitives — canonicalization, subtag decomposition, likely-subtag
 * maximization, RFC 4647 lookup/filtering, and display names.
 *
 * Canonical tags (as returned by `canonicalizeTag`) are the system's
 * preferred language identifiers: they key the LanguageTag table and appear
 * in public API payloads. All matching here is case-insensitive; storage is
 * always canonical case ("zh-Hant", "en-US").
 */

export interface ParsedTag {
  /** Full canonical tag: "zh-Hant", "en-US". */
  tag: string;

  /** Primary language subtag, lowercase: "zh", "en", "cmn". */
  language: string;

  /** ISO 15924 script subtag in title case, when present: "Hant". */
  script?: string;

  /** ISO 3166-1 alpha-2 / UN M49 region subtag, when present: "US", "419". */
  region?: string;
}

/**
 * Canonicalize a BCP 47 language tag: case normalization and deprecated-tag
 * replacement, per Intl.getCanonicalLocales.
 *
 * Returns null for syntactically invalid input — and for tags whose primary
 * language subtag is not 2–3 letters. BCP 47 syntax technically allows 4–8
 * letter primary subtags, but none are registered for real languages, while
 * free-text display names ("English", "Klingon") happen to parse as valid
 * 4–8 letter subtags. Rejecting them keeps auto-added vocabulary honest.
 */
export function canonicalizeTag(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  let canonical: string;
  try {
    const [first] = Intl.getCanonicalLocales(trimmed);
    if (!first) {
      return null;
    }
    canonical = first;
  } catch {
    return null;
  }

  const primary = canonical.split('-')[0];
  if (!/^[a-z]{2,3}$/i.test(primary)) {
    return null;
  }

  return canonical;
}

/**
 * Canonicalize and decompose a tag into its language/script/region subtags.
 * Only explicit subtags are reported — use `maximizeTag` for likely subtags.
 */
export function parseTag(value: string | null | undefined): ParsedTag | null {
  const tag = canonicalizeTag(value);
  if (!tag) {
    return null;
  }

  const locale = new Intl.Locale(tag);
  return {
    tag,
    language: locale.language,
    script: locale.script,
    region: locale.region,
  };
}

/**
 * Canonicalize and expand a tag with its likely subtags (CLDR):
 * "zh" → { language: "zh", script: "Hans", region: "CN" }.
 */
export function maximizeTag(value: string | null | undefined): ParsedTag | null {
  const tag = canonicalizeTag(value);
  if (!tag) {
    return null;
  }

  const maximized = new Intl.Locale(tag).maximize();
  return {
    tag: maximized.toString(),
    language: maximized.language,
    script: maximized.script,
    region: maximized.region,
  };
}

/**
 * RFC 4647 §3.4 lookup: resolve a prioritized list of ranges to the single
 * best-matching available tag by progressively truncating each range from
 * the right ("zh-Hant-TW" → "zh-Hant" → "zh") before moving to the next
 * range. Returns the available tag in its original casing, or undefined.
 */
export function lookupTag(ranges: readonly string[], available: Iterable<string>): string | undefined {
  const byLower = new Map<string, string>();
  for (const tag of available) {
    byLower.set(tag.toLowerCase(), tag);
  }

  for (const range of ranges) {
    let candidate = (canonicalizeTag(range) ?? range).trim().toLowerCase();

    while (candidate) {
      const match = byLower.get(candidate);
      if (match) {
        return match;
      }

      candidate = truncateRange(candidate);
    }
  }

  return undefined;
}

/**
 * Drop the last subtag; per RFC 4647, a now-trailing single-character
 * subtag (an extension singleton) is dropped along with it.
 */
function truncateRange(range: string): string {
  const subtags = range.split('-');
  subtags.pop();

  if (subtags.length > 0 && subtags[subtags.length - 1].length === 1) {
    subtags.pop();
  }

  return subtags.join('-');
}

/**
 * RFC 4647 §3.3.1 basic filtering: all available tags that match the range —
 * equal to it, or extending it at a subtag boundary. "zh" matches "zh",
 * "zh-Hant", "zh-Hant-TW"; it does not match "zho". "*" matches everything.
 */
export function filterTags(range: string, available: Iterable<string>): string[] {
  const normalized = range.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const all = [...available];
  if (normalized === '*') {
    return all;
  }

  const prefix = `${normalized}-`;
  return all.filter((tag) => {
    const lower = tag.toLowerCase();
    return lower === normalized || lower.startsWith(prefix);
  });
}

/**
 * English (or `displayLocale`-localized) display name for a tag, in CLDR
 * "standard" style: "en-US" → "English (United States)". Returns null when
 * the tag is invalid or ICU has no name for it.
 */
export function displayName(value: string | null | undefined, displayLocale = 'en'): string | null {
  const tag = canonicalizeTag(value);
  if (!tag) {
    return null;
  }

  try {
    const name = new Intl.DisplayNames([displayLocale], {
      type: 'language',
      languageDisplay: 'standard',
      fallback: 'none',
    }).of(tag);

    return name ?? null;
  } catch {
    return null;
  }
}

/**
 * Display name of a tag in its own language: "de-DE" → "Deutsch (Deutschland)".
 */
export function nativeDisplayName(value: string | null | undefined): string | null {
  const tag = canonicalizeTag(value);
  if (!tag) {
    return null;
  }

  return displayName(tag, tag);
}

/**
 * Normalization key for display-name matching (BGG-style free-text values):
 * trimmed, whitespace-collapsed, lowercased. Not a linguistic normalization —
 * just enough to make "  Czech " and "czech" compare equal.
 */
export function nameKey(name: string | null | undefined): string | null {
  const key = name?.trim().replace(/\s+/g, ' ').toLowerCase();
  return key || null;
}
