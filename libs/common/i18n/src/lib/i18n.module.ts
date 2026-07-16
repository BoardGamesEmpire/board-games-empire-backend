import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { I18nModule } from 'nestjs-i18n';
import * as path from 'node:path';
import { ClsLocaleResolver } from './cls-locale.resolver';
import { FALLBACK_LOCALE } from './locale.constants';
import { LocaleResolutionService } from './locale-resolution.service';
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
 * Catalogs live beside this module at `./i18n/<locale>/*.json`. Resolving from
 * `__dirname` works in jest (swc, unbundled — `__dirname` is this source dir)
 * and in a build where `./i18n` has been copied into the app's `dist` as a
 * webpack asset (`__dirname` is the app's `dist` dir). Each in-scope app
 * (api, worker, gateway-worker) wires that copy in its `webpack.config.js`
 * (#139).
 */
@Module({
  imports: [
    DatabaseModule,
    I18nModule.forRoot({
      fallbackLanguage: FALLBACK_LOCALE,
      loaderOptions: {
        path: path.join(__dirname, 'i18n'),
        watch: false,
      },
      resolvers: [ClsLocaleResolver],
    }),
  ],
  providers: [LocaleResolutionService, SupportedLocalesService],
  exports: [I18nModule, LocaleResolutionService, SupportedLocalesService],
})
export class I18nConfigModule {}
