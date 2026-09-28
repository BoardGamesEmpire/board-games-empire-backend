// The translatable primitives live in `@bge/i18n-core`, which depends on nothing
// that reads the request context or loads nestjs-i18n. They are re-exported here
// so application code imports everything translation-related from one place:
// import from `@bge/i18n`. Reach for `@bge/i18n-core` only from a lib this one
// depends on (`@bge/actor-context`, #189), or from one loaded by processes that
// emit no localized text (`@bge/shared`, #503). `I18nPath` and
// `I18nTranslations` let consumers type `I18nContext<I18nTranslations>`, `t()`,
// and `i18nValidationMessage(...)` against real keys — invalid keys fail `tsc`.
export {
  I18N_CATALOG_DIR,
  I18nMessage,
  i18nValidationMessage,
  isI18nMessage,
  t,
  type I18nPath,
  type I18nTranslations,
  type I18nValidationPath,
} from '@bge/i18n-core';
export { ClsLocaleResolver } from './lib/cls-locale.resolver';
export { I18nExceptionFilter } from './lib/i18n-exception.filter';
export { I18nResponseInterceptor } from './lib/i18n-response.interceptor';
export { I18nConfigModule } from './lib/i18n.module';
export { LocaleResolutionService, type LocaleResolutionInput } from './lib/locale-resolution.service';
export { FALLBACK_LOCALE } from './lib/locale.constants';
export { SupportedLocalesService } from './lib/supported-locales.service';
export { translateException } from './lib/translate-exception';
export { translateValidationErrors } from './lib/translate-validation-errors';
