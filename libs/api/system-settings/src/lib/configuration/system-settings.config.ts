import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface SystemSettingsConfig {
  identifier: string | null;
}

export default registerAs('systemSettings', () =>
  env.provideMany<SystemSettingsConfig>([
    {
      keyTo: 'identifier',
      key: 'SERVER_IDENTIFIER',
      defaultValue: null,
      allowEmptyString: true,
    },
  ]),
);

export const systemSettingsConfigValidationSchema = {
  SERVER_IDENTIFIER: Joi.string().optional().allow(null, ''),
};
