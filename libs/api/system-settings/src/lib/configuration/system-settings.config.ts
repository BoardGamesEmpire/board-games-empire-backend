import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface SystemSettingsConfig {
  allowPasswordResets: boolean;
  allowUsernameChange: boolean;
  allowUserRegistration: boolean;
  serverIdentifier: string | null;
}

export default registerAs('systemSettings', () =>
  env.provideMany<SystemSettingsConfig>([
    {
      keyTo: 'serverIdentifier',
      key: 'SERVER_IDENTIFIER',
      defaultValue: null,
      allowEmptyString: true,
    },
    {
      keyTo: 'allowUserRegistration',
      key: 'ALLOW_USER_REGISTRATION',
      defaultValue: true,
    },
    {
      keyTo: 'allowPasswordResets',
      key: 'ALLOW_PASSWORD_RESETS',
      defaultValue: true,
    },
    {
      keyTo: 'allowUsernameChange',
      key: 'ALLOW_USERNAME_CHANGE',
      defaultValue: true,
    },
  ]),
);

export const systemSettingsConfigValidationSchema = {
  SERVER_IDENTIFIER: Joi.string().optional().allow(null, ''),
  ALLOW_USER_REGISTRATION: Joi.boolean().optional(),
  ALLOW_PASSWORD_RESETS: Joi.boolean().optional(),
  ALLOW_USERNAME_CHANGE: Joi.boolean().optional(),
};
