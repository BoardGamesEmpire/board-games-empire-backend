import { env, isTrue, splitTrimFilter } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface AuthConfig {
  authSecret: string;
  disableEmailSignUp: boolean;
  disableOriginCheck: boolean;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcProviderId: string;
  oidcWellKnownUrl: string;
  sendEmailVerification: boolean;
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
        testing: 'testing-secret',
        staging: 'staging-secret',
      },
    },
    {
      keyTo: 'url',
      key: 'BETTER_AUTH_URL',
      defaultValue: 'http://localhost',
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
      keyTo: 'disableEmailSignUp',
      key: 'DISABLE_EMAIL_SIGN_UP',
      defaultValue: false,
      mutators: isTrue,
    },
    {
      keyTo: 'sendEmailVerification',
      key: 'SEND_EMAIL_VERIFICATION',
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

export const authConfigValidationSchema = {
  BETTER_AUTH_SECRET: Joi.string().min(10).required(),
  BETTER_AUTH_URL: Joi.string().uri().required(),
  DISABLE_EMAIL_SIGN_UP: Joi.boolean().optional(),
  OIDC_CLIENT_ID: Joi.string().optional().allow(''),
  OIDC_CLIENT_SECRET: Joi.string().optional().allow(''),
  OIDC_PROVIDER_ID: Joi.string().optional().allow(''),
  OIDC_WELL_KNOWN_URL: Joi.string().uri().optional().allow(''),
  SEND_EMAIL_VERIFICATION: Joi.boolean().optional(),
  TRUSTED_ORIGINS: Joi.string().optional(),
  DISABLE_ORIGIN_CHECK: Joi.boolean().optional(),
  USE_EMAIL_PASSWORD_AUTH: Joi.boolean().optional(),
};
