// The translatable primitives live in `@bge/i18n-core`, which depends on nothing
// that reads the request context — so `@bge/actor-context`, which this lib
// depends on, can mark its own strings without a circular project reference
// (#189). They are re-exported here so application code imports everything
// translation-related from one place: import from `@bge/i18n`, and reach for
// `@bge/i18n-core` only from a lib this one depends on. `I18nPath` and
// `I18nTranslations` let consumers type `I18nContext<I18nTranslations>`, `t()`,
// and `i18nValidationMessage(...)` against real keys — invalid keys fail `tsc`.
export { I18nMessage, isI18nMessage, t, type I18nPath, type I18nTranslations } from '@bge/i18n-core';
export { ClsLocaleResolver } from './lib/cls-locale.resolver';
export { I18nExceptionFilter } from './lib/i18n-exception.filter';
export { I18nResponseInterceptor } from './lib/i18n-response.interceptor';
export { I18nConfigModule } from './lib/i18n.module';
export { LocaleResolutionService, type LocaleResolutionInput } from './lib/locale-resolution.service';
export { FALLBACK_LOCALE } from './lib/locale.constants';
export { SupportedLocalesService } from './lib/supported-locales.service';
export { translateException } from './lib/translate-exception';
export { i18nValidationMessage, type I18nValidationPath } from './lib/validation-message';
