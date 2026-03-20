import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface IGDBConfig {
  clientId: string;
  clientSecret: string;
}

export default registerAs('igdb', () =>
  env.provideMany<IGDBConfig>([
    {
      key: 'IGDB_CLIENT_ID',
      keyTo: 'clientId',
    },
    {
      key: 'IGDB_CLIENT_SECRET',
      keyTo: 'clientSecret',
    },
  ]),
);

export const igdbConfigValidationSchema = {
  IGDB_CLIENT_ID: Joi.string().required(),
  IGDB_CLIENT_SECRET: Joi.string().required(),
};
