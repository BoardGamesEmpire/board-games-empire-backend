import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

/**
 * Where the coordinator finds the plugins it loads: the data-gateway plugins,
 * which it hosts (#1083). The api installs them under its own plugins root,
 * so this must name the same directory: the same variable, the same defaults
 * and the same validation as `apps/api/src/app/configuration/plugins.config.ts`.
 * Keep the two in step. Each app has its own copy because an app can't import
 * another's files, and the root belongs to neither lib that reads it.
 *
 * The coordinator only reads the root; the api's install, update and artifact
 * sweep are what write to it.
 */
export interface PluginsConfig {
  /**
   * Root directory for installed plugins, one directory per plugin artifact
   * (`<pluginsRoot>/<slug>/<sha256>`, #224).
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
 * `.allow('')`, as the api's schema has it: `.env.example` ships the root
 * empty, which `@bge/env` reads as unset, so the config above defaults it.
 */
export const pluginsConfigValidationSchema = {
  PLUGINS_ROOT: Joi.string().optional().allow(''),
};
