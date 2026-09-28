// The translatable vocabulary: the catalogs, the key types generated from them,
// and the markers call sites use to name a key without translating it (`t()`
// for exceptions, `i18nValidationMessage` for decorators). Nothing here reads
// the request context or loads nestjs-i18n. `@bge/i18n` builds on these and
// re-exports them beside the edge machinery that does the translating, and
// everything imports them there, with two exceptions:
//  - a lib `@bge/i18n` itself depends on (`@bge/actor-context`), which would
//    otherwise form a circular project reference (#189);
//  - a lib loaded by processes that emit no localized text (`@bge/shared`, which
//    the IGDB and BGG gateways load at boot), which would otherwise carry
//    nestjs-i18n and `@bge/database` into them (#503).
export { I18N_CATALOG_DIR } from './lib/catalog';
// Generated from the `en` catalog by the nestjs-i18n CLI, and NOT committed (#260).
// Nx produces it as a dependency of `typecheck` (this project's own, plus the
// `^generate` default in nx.json for everything downstream) and of every app's
// `build`. On a fresh clone the file does not exist until one of those runs;
// `npm run i18n:generate` refreshes it directly if your editor needs it sooner.
// See "Known hazard" in docs/i18n/typed-keys.md before trusting a cached
// typecheck after a catalog edit.
export type { I18nPath, I18nTranslations } from './lib/generated/i18n.generated';
export { I18nMessage, isI18nMessage, t } from './lib/translatable';
export { i18nValidationMessage, type I18nValidationPath } from './lib/validation-message';
