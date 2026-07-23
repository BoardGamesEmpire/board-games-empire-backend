import { z } from 'zod';

/**
 * `LocalizedString` — every user-facing manifest field accepts either a bare
 * string (shorthand for `{ [defaultLocale]: value }`) or a locale-keyed map.
 *
 * The zod schema here is purely STRUCTURAL (and therefore lossless in the
 * generated JSON Schema artifact); BCP 47 well-formedness of the map keys and
 * presence of the configured default locale are semantic-pass rules
 * (`manifest-validator.ts`) because they depend on runtime configuration.
 */
export const localizedStringSchema = z.union([
  z.string().min(1),
  z.record(z.string().min(2).max(35), z.string().min(1)),
]);

export type LocalizedString = z.infer<typeof localizedStringSchema>;

/**
 * BCP 47 well-formedness check via the platform's own tag grammar.
 * `Intl.getCanonicalLocales` throws `RangeError` on structurally invalid
 * tags — no third-party dependency, standards-exact.
 */
export const isWellFormedBcp47 = (tag: string): boolean => {
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
};

/** Canonical form for case-insensitive comparisons (`en-us` → `en-US`). Throws on malformed tags. */
export const canonicalizeLocale = (tag: string): string => {
  const [canonical] = Intl.getCanonicalLocales(tag);

  if (canonical === undefined) {
    throw new RangeError(`Cannot canonicalize empty locale tag list for '${tag}'`);
  }

  return canonical;
};

export interface ResolveLocaleOptions {
  /** The requester's locale (e.g. from `Accept-Language` / user preference). */
  readonly locale: string;
  /** The server's configured default locale — guaranteed present by the validator. */
  readonly defaultLocale: string;
}

export interface ResolvedLocalizedString {
  readonly value: string;
  /** Which locale the value was served from (canonical form for map hits). */
  readonly locale: string;
  /** True when neither the requested locale nor its base language matched. */
  readonly usedFallback: boolean;
}

/**
 * Resolution chain: exact tag → base language (`de-AT` → `de`) → other
 * regional variant of the language → default locale → first defined entry.
 * The final step exists only for defensive completeness on unvalidated
 * input; validator-passed manifests always carry the default locale, so
 * resolution is total for them.
 */
export const resolveLocalizedStringDetailed = (
  value: LocalizedString,
  options: ResolveLocaleOptions,
): ResolvedLocalizedString => {
  if (typeof value === 'string') {
    // Bare string is shorthand for the default locale; it's a fallback for any
    // requester whose locale isn't the default (canonical comparison).
    const usedFallback = !(
      isWellFormedBcp47(options.locale) &&
      isWellFormedBcp47(options.defaultLocale) &&
      canonicalizeLocale(options.locale) === canonicalizeLocale(options.defaultLocale)
    );

    return { value, locale: options.defaultLocale, usedFallback };
  }

  const canonicalEntries = new Map<string, { readonly original: string; readonly text: string }>();

  for (const [tag, text] of Object.entries(value)) {
    if (isWellFormedBcp47(tag)) {
      canonicalEntries.set(canonicalizeLocale(tag), { original: tag, text });
    }
  }

  const lookup = (tag: string): ResolvedLocalizedString | undefined => {
    if (!isWellFormedBcp47(tag)) {
      return undefined;
    }

    const canonical = canonicalizeLocale(tag);
    const hit = canonicalEntries.get(canonical);

    return hit === undefined ? undefined : { value: hit.text, locale: canonical, usedFallback: false };
  };

  const exact = lookup(options.locale);
  if (exact !== undefined) {
    return exact;
  }

  const baseLanguageOf = (tag: string): string => {
    const [base] = tag.split('-');

    return base ?? tag;
  };

  if (isWellFormedBcp47(options.locale)) {
    const baseLanguage = baseLanguageOf(canonicalizeLocale(options.locale));

    if (baseLanguage !== options.locale) {
      const base = lookup(baseLanguage);
      if (base !== undefined) {
        return { ...base, usedFallback: true };
      }
    }

    // Regional-variant fallback: a `de`/`de-AT` requester should still be
    // served a `de-DE`-only map rather than dropping to the default locale.
    // First matching entry in insertion order wins — deterministic, and maps
    // with multiple variants of one language should carry the bare subtag.
    for (const [canonical, entry] of canonicalEntries) {
      if (baseLanguageOf(canonical) === baseLanguage) {
        return { value: entry.text, locale: canonical, usedFallback: true };
      }
    }
  }

  const defaultHit = lookup(options.defaultLocale);
  if (defaultHit !== undefined) {
    return { ...defaultHit, usedFallback: true };
  }

  const [first] = canonicalEntries.entries();
  if (first === undefined) {
    throw new RangeError('Cannot resolve a LocalizedString with no well-formed locale entries');
  }

  const [locale, entry] = first;

  return { value: entry.text, locale, usedFallback: true };
};

/** Convenience form — most call sites only want the text. */
export const resolveLocalizedString = (value: LocalizedString, options: ResolveLocaleOptions): string =>
  resolveLocalizedStringDetailed(value, options).value;
