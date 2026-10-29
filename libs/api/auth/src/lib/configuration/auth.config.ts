import { env, isTrue, splitTrimFilter } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';
import { readOidcProviders, type OidcProviderConfig } from './oidc-providers';

export interface AuthConfig {
  disableOriginCheck: boolean;
  oidcProviders: readonly OidcProviderConfig[];
  secret: string;
  trustedOrigins: string[];
  url: string;
  useEmailPasswordAuth: boolean;
}

export default registerAs('auth', (): AuthConfig => {
  const config = env.provideMany<Omit<AuthConfig, 'oidcProviders'>>([
    {
      keyTo: 'secret',
      key: 'BETTER_AUTH_SECRET',
      defaultsFor: {
        development: 'development-secret',
        test: 'test-secret',
      },
    },
    {
      keyTo: 'url',
      key: 'BETTER_AUTH_URL',
      // Sign-in fails at an address clients don't reach, so a server reachable
      // from outside names its own.
      defaultsFor: {
        development: 'http://localhost',
        test: 'http://localhost',
      },
    },
    {
      keyTo: 'trustedOrigins',
      key: 'TRUSTED_ORIGINS',
      defaultValue: 'http://localhost',
      mutators: splitTrimFilter,
    },
    {
      keyTo: 'disableOriginCheck',
      key: 'DISABLE_ORIGIN_CHECK',
      defaultValue: false,
      mutators: [isTrue, (value: boolean) => (env.isProduction ? false : value)],
    },
    {
      keyTo: 'useEmailPasswordAuth',
      key: 'USE_EMAIL_PASSWORD_AUTH',
      defaultValue: true,
      mutators: isTrue,
    },
  ]);

  // The providers' variables depend on the ids listed, so they are read
  // beside the fixed ones rather than through `provideMany`'s list (#912).
  return { ...config, oidcProviders: readOidcProviders() };
});

/**
 * For the api's root schema: the auth module loads this config with
 * `forFeature`, which validates nothing. The secret and the URL are not
 * required here, because the config above defaults them in development and
 * test, and Joi runs first: a required variable would stop a development boot
 * that has no `.env`. Where the config has no default, it refuses to start
 * without them. The rules still reject a value that is set but malformed.
 * Each accepts `''`, which `@bge/env` reads as unset.
 */
export const authConfigValidationSchema = {
  BETTER_AUTH_SECRET: Joi.string().min(10).allow(''),
  BETTER_AUTH_URL: Joi.string().uri().allow(''),
  OIDC_PROVIDERS: Joi.string().optional().allow(''),
  TRUSTED_ORIGINS: Joi.string().optional().allow(''),
  DISABLE_ORIGIN_CHECK: Joi.boolean().optional().allow(''),
  USE_EMAIL_PASSWORD_AUTH: Joi.boolean().optional().allow(''),
};
