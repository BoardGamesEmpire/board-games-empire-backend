export { ClsLocaleResolver } from './lib/cls-locale.resolver';
// Generated from the `en` catalog by the nestjs-i18n CLI, and NOT committed (#260).
// Nx produces it as a dependency of `typecheck` (the `^generate` default in
// nx.json — note `@bge/database` and `proto-gateway` override `typecheck.dependsOn`
// and so opt out; neither imports this lib) and of every app's `build`. On a fresh
// clone the file does not exist until one of those runs; `npm run i18n:generate`
// refreshes it directly if your editor needs it sooner. See "Known hazard" in
// docs/i18n/typed-keys.md before trusting a cached typecheck after a catalog edit.
// Re-exported so consumers type `I18nContext<I18nTranslations>`, `t()`, and
// `i18nValidationMessage<I18nTranslations>(...)` against real keys — invalid
// keys then fail `tsc`.
export type { I18nPath, I18nTranslations } from './lib/generated/i18n.generated';
export { I18nConfigModule } from './lib/i18n.module';
export { I18nExceptionFilter } from './lib/i18n-exception.filter';
export { I18nResponseInterceptor } from './lib/i18n-response.interceptor';
export { LocaleResolutionService, type LocaleResolutionInput } from './lib/locale-resolution.service';
export { FALLBACK_LOCALE } from './lib/locale.constants';
export { SupportedLocalesService } from './lib/supported-locales.service';
export { translateException } from './lib/translate-exception';
export { I18nMessage, isI18nMessage, t } from './lib/translatable';
export { i18nValidationMessage, type I18nValidationPath } from './lib/validation-message';
