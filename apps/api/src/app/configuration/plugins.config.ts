import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

/**
 * Host configuration for the plugin runtime (`PluginModule`, #59 Phase B),
 * wired into this app per #212: the plugin root. The other
 * `PluginModuleOptions` values are not environment-sourced — `bgeVersion` is
 * a build-time codegen constant (`@bge/version`) and `defaultLocale` is the
 * i18n catalog fallback. There is no second root for plugins shipped inside
 * the server, because there are none (#696).
 */
export interface PluginsConfig {
  /**
   * Root directory for installed plugins, one directory per plugin artifact
   * (`<pluginsRoot>/<slug>/<sha256>`, #224), which the install ingress is to
   * populate (planned, #1094). Must survive OS temp-cleaning: installed `Plugin` rows reference
   * directories under this root, and a vanished root quarantines
   * (force-disables) every installed plugin on the next boot.
   */
  pluginsRoot: string;
}

export default registerAs('plugins', () =>
  env.provideMany<PluginsConfig>([
    {
      keyTo: 'pluginsRoot',
      key: 'PLUGINS_ROOT',
      defaultValue: './data/plugins',
      defaultsFor: {
        production: '/var/lib/bge/plugins',
      },
    },
  ]),
);

/**
 * The root ships empty in `.env.example` (`PLUGINS_ROOT=`), which is how a
 * fresh `cp .env.example .env` opts into the default declared above: `@bge/env`
 * is created with `allowEmptyString: false`, so an empty value is treated as
 * unset and `defaultValue` applies.
 *
 * Joi runs first, though, and a bare `Joi.string()` rejects `''` outright —
 * boot dies on validation before the provider ever sees the key. `.allow('')`
 * hands the empty value through to the layer that knows what to do with it,
 * as auth's schema does for `OIDC_PROVIDERS`.
 */
export const pluginsConfigValidationSchema = {
  PLUGINS_ROOT: Joi.string().optional().allow(''),
};
