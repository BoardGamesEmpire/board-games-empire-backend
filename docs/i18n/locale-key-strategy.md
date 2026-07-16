# i18n Locale-Key Strategy (#137)

Phase 0 deliverable for the i18n epic (#135). Reconciles the DB `Language`/`LanguageTag`
model with the locale keys `nestjs-i18n` and its tooling expect, so Phase 1 module wiring
(#138–#141) can proceed against a settled convention.

## Background

The DB originally identified languages by ISO 639-3 (`Language.code`), while `nestjs-i18n`
and most i18n tooling key catalogs by BCP 47 / ISO 639-1 folder names (`en`, `es`, `zh-Hant`).
#137 was opened to pick and document that mapping. Its blocker, the language-model rework
(#37), has since landed (commit `f4c4bc1`) and **already resolves the ambiguity** — this doc
ratifies the resulting convention rather than inventing a new one.

## Decision

**The catalog folder name is the canonical BCP 47 `LanguageTag.tag`.** Catalogs are keyed by
the tags whose `LanguageTag.systemSupported` flag is `true`. Today that set is `['en']`.

- `LanguageTag.tag` is stored canonical (`Intl.getCanonicalLocales`) and is documented in the
  schema as *"the system's preferred language identifier … the public API identifier"* —
  `prisma/models/system/language.prisma`.
- `systemSupported` is a boolean on **`LanguageTag`** (locale-scoped), not on `Language`. A
  language "is supported" iff one of its tags is.

## Rationale

- `LanguageTag.tag` is already the canonical, public BCP 47 identifier — releases, households,
  and user preferences all reference tags — and it matches `nestjs-i18n`'s folder-name
  expectations directly. No separate mapping table or lookup column is needed.
- #37's rework subsumed the original "ISO 639-1 vs 639-3 vs a new `ietfTag`" question: there is
  no `ietfTag` column; the `LanguageTag.tag` row **is** the IETF tag.
- ISO codes remain on `Language` (`iso6393`, `iso6391`) for gateway/interoperability mapping,
  but they are **not** the catalog key.

## Key mapping

- **DB tag → catalog folder: identity.** The folder name *is* the canonical tag
  (`en`, `zh-Hant`). No conversion function exists or is needed.
- **Requested locale → catalog folder: `resolveCatalogLocale`** in `@bge/locale`
  (`libs/common/locale/src/lib/locale.ts`). It resolves a caller's prioritized ranges
  (Accept-Language, a stored preference tag) to a shipped catalog via RFC 4647 §3.4 lookup
  (`lookupTag`), falling back to a default (`en`) when nothing matches — e.g. `en-US` → `en`.
  It is a pure function; the caller supplies the `supported` set and `fallback`.

## Source of truth & integrity guard

- The supported-locale set is seeded from `systemSupportedTags` in
  `prisma/seeds/languages.seed.ts` (`['en']`, pending i18n expansion).
- `assertSystemSupportedTags` runs at seed time and throws unless every entry is a canonical
  BCP 47 tag **and** present in the curated vocabulary — catching typos (`en-us`, `english`)
  or un-curated tags that would otherwise silently yield zero supported locales.

## Fallback default

The default catalog locale is **`en`**. Where the resolver chain reads it (env/config) and how
`supported` is sourced at request time (a DB query for `systemSupported: true`) are owned by the
locale resolver work in **#140**.

## Deferred

- **#138** — done on this branch: the `I18nModule` loader (`@bge/i18n` → `I18nConfigModule`)
  and the initial `en` catalog now exist. A guard asserting a catalog folder physically exists
  for *every* `systemSupported` tag is not yet wired.
- **#139** — ship catalog folders as nx build assets. Done for the **api** app
  (`apps/api/webpack.config.js`); the worker / gateway-worker globs are still pending.
- **#140** — the request-time locale resolver chain + CLS-stored locale that consumes
  `resolveCatalogLocale`.
