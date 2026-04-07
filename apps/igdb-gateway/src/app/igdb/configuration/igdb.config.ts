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
      defaultsFor: {
        test: 'test-client-id',
      },
    },
    {
      key: 'IGDB_CLIENT_SECRET',
      keyTo: 'clientSecret',
      defaultsFor: {
        test: 'test-secret',
      },
    },
  ]),
);

export const igdbConfigValidationSchema = {
  IGDB_CLIENT_ID: Joi.string().required(),
  IGDB_CLIENT_SECRET: Joi.string().required(),
};
