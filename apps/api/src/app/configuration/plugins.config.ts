import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

/**
 * Host configuration for the plugin runtime (`PluginModule`, #59 Phase B),
 * wired into this app per #212: the two plugin roots. The other
 * `PluginModuleOptions` values are not environment-sourced — `bgeVersion` is
 * a build-time codegen constant (`generated/bge-version.ts`) and
 * `defaultLocale` is the i18n catalog fallback.
 */
export interface PluginsConfig {
  /**
   * Root directory for tarball-installed plugins (`<pluginsRoot>/<slug>`),
   * populated by the #84 install pipeline. Must survive OS temp-cleaning:
   * installed `Plugin` rows reference directories under this root, and a
   * vanished root quarantines (force-disables) every installed plugin on the
   * next boot.
   */
  pluginsRoot: string;

  /**
   * Root directory for plugins shipped in-tree with BGE
   * (`<bundledRoot>/<slug>`). Default is provisional — no bundled plugin
   * exists until #61, which fixes the real dist layout.
   */
  bundledRoot: string;
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
    {
      keyTo: 'bundledRoot',
      key: 'PLUGINS_BUNDLED_ROOT',
      defaultValue: './plugins/bundled',
    },
  ]),
);

/**
 * Both roots ship empty in `.env.example` (`PLUGINS_ROOT=`), which is how a
 * fresh `cp .env.example .env` opts into the defaults declared above: `@bge/env`
 * is created with `allowEmptyString: false`, so an empty value is treated as
 * unset and `defaultValue` applies.
 *
 * Joi runs first, though, and a bare `Joi.string()` rejects `''` outright —
 * boot dies on validation before the provider ever sees the key. `.allow('')`
 * hands the empty value through to the layer that knows what to do with it,
 * matching the `SERVER_IDENTIFIER` precedent in the system-settings config.
 */
export const pluginsConfigValidationSchema = {
  PLUGINS_ROOT: Joi.string().optional().allow(''),
  PLUGINS_BUNDLED_ROOT: Joi.string().optional().allow(''),
};
