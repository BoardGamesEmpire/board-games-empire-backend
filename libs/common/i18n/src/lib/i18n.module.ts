import { Module } from '@nestjs/common';
import { I18nModule } from 'nestjs-i18n';
import * as path from 'node:path';

/**
 * Wraps nestjs-i18n's (global) `I18nModule` with the BGE catalog configuration
 * and re-exports it, so any app that imports `I18nConfigModule` gets a ready
 * `I18nService`.
 *
 * Catalogs live beside this module at `./i18n/<locale>/*.json`. Resolving from
 * `__dirname` works in jest (swc, unbundled — `__dirname` is this source dir)
 * and in a build where `./i18n` has been copied into the app's `dist` as a
 * webpack asset (`__dirname` is the app's `dist` dir). The api app wires that
 * copy in `apps/api/webpack.config.js`; the other in-scope apps (worker,
 * gateway-worker) add the same glob when the module is wired into them
 * (#139/#146).
 *
 * The resolved locale is currently only ever the fallback (`en`); the
 * request-time resolver chain (UserPreference → Accept-Language → fallback)
 * lands in #140.
 */
@Module({
  imports: [
    I18nModule.forRoot({
      fallbackLanguage: 'en',
      loaderOptions: {
        path: path.join(__dirname, 'i18n'),
        watch: false,
      },
    }),
  ],
  exports: [I18nModule],
})
export class I18nConfigModule {}
