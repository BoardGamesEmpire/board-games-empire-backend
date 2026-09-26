import { DatabaseModule } from '@bge/database';
import { I18N_CATALOG_DIR } from '@bge/i18n-core';
import { Module } from '@nestjs/common';
import { I18nModule } from 'nestjs-i18n';
import { ClsLocaleResolver } from './cls-locale.resolver';
import { LocaleResolutionService } from './locale-resolution.service';
import { FALLBACK_LOCALE } from './locale.constants';
import { SupportedLocalesService } from './supported-locales.service';

/**
 * Wraps nestjs-i18n's (global) `I18nModule` with the BGE catalog configuration
 * and re-exports it, so any app that imports `I18nConfigModule` gets a ready
 * `I18nService`, plus the locale-resolution services:
 *
 * - `SupportedLocalesService` — boot-time supported-locale set (DB
 *   `systemSupported` tags ∩ shipped catalogs, drift warned).
 * - `LocaleResolutionService` — user preference → Accept-Language → fallback,
 *   used by the HTTP `LocaleResolutionMiddleware` and by the queue/gRPC seams
 *   in #146/#147.
 * - `ClsLocaleResolver` — the only nestjs-i18n resolver; reads the locale the
 *   entry seam stored in CLS. Requires `ClsModule.forRoot({ global: true })`
 *   in the application graph.
 *
 * Catalogs live in `@bge/i18n-core`, beside the key types generated from them;
 * `I18N_CATALOG_DIR` resolves to them under jest and to the copy each in-scope
 * app (api, worker, gateway-worker) makes into its `dist` as a webpack asset
 * (#139).
 */
@Module({
  imports: [
    DatabaseModule,
    I18nModule.forRoot({
      fallbackLanguage: FALLBACK_LOCALE,
      loaderOptions: {
        path: I18N_CATALOG_DIR,
        watch: false,
      },
      resolvers: [ClsLocaleResolver],
    }),
  ],
  providers: [LocaleResolutionService, SupportedLocalesService],
  exports: [I18nModule, LocaleResolutionService, SupportedLocalesService],
})
export class I18nConfigModule {}
