import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface IGDBConfig {
  client_id: string;
  client_secret: string;
}

export default registerAs('boardgamegeek', () =>
  env.provideMany<IGDBConfig>([
    {
      key: 'IGDB_CLIENT_ID',
      keyTo: 'client_id',
    },
    {
      key: 'IGDB_CLIENT_SECRET',
      keyTo: 'client_secret',
    },
  ]),
);

export const igdbConfigValidationSchema = {
  IGDB_CLIENT_ID: Joi.string().required(),
  IGDB_CLIENT_SECRET: Joi.string().required(),
};
