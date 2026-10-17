import { env, isTrue, splitTrimFilter } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface AuthConfig {
  disableOriginCheck: boolean;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcProviderId: string;
  oidcWellKnownUrl: string;
  secret: string;
  trustedOrigins: string[];
  url: string;
  useEmailPasswordAuth: boolean;
}

export default registerAs('auth', () =>
  env.provideMany<AuthConfig>([
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
    {
      keyTo: 'oidcWellKnownUrl',
      key: 'OIDC_WELL_KNOWN_URL',
      defaultValue: '',
      allowEmptyString: true,
    },
    {
      keyTo: 'oidcClientId',
      key: 'OIDC_CLIENT_ID',
      defaultValue: '',
      allowEmptyString: true,
    },
    {
      keyTo: 'oidcClientSecret',
      key: 'OIDC_CLIENT_SECRET',
      defaultValue: '',
      allowEmptyString: true,
    },
    {
      keyTo: 'oidcProviderId',
      key: 'OIDC_PROVIDER_ID',
      defaultValue: '',
      allowEmptyString: true,
    },
  ]),
);

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
  OIDC_CLIENT_ID: Joi.string().optional().allow(''),
  OIDC_CLIENT_SECRET: Joi.string().optional().allow(''),
  OIDC_PROVIDER_ID: Joi.string().optional().allow(''),
  OIDC_WELL_KNOWN_URL: Joi.string().uri().optional().allow(''),
  TRUSTED_ORIGINS: Joi.string().optional().allow(''),
  DISABLE_ORIGIN_CHECK: Joi.boolean().optional().allow(''),
  USE_EMAIL_PASSWORD_AUTH: Joi.boolean().optional().allow(''),
};
