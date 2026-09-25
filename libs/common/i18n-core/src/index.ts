// The translatable vocabulary: the catalogs, the key types generated from them,
// and the `t()` marker call sites use to name a key without translating it.
// Nothing here reads the request context or loads nestjs-i18n, so a lib that
// `@bge/i18n` itself depends on (`@bge/actor-context`) can mark its strings
// without forming a circular project reference (#189), and without every
// importer of that lib paying for nestjs-i18n at load time. `@bge/i18n` builds on
// these and re-exports them beside `i18nValidationMessage` (a nestjs-i18n facade)
// and the edge machinery that does the translating; everything else imports them
// there.
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
