import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';
import { TWITCH_TOKEN_URL } from '../lib/fetch-access-token';

export interface IGDBConfig {
  clientId: string;
  clientSecret: string;

  /**
   * Where the client-credentials token comes from. Twitch's endpoint unless
   * overridden, which the e2e suite does so the gateway can boot without
   * calling Twitch.
   */
  tokenUrl: string;
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
    {
      key: 'IGDB_TOKEN_URL',
      keyTo: 'tokenUrl',
      defaultValue: TWITCH_TOKEN_URL,
    },
  ]),
);

/** The hosts a plain-http token URL may name. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const igdbConfigValidationSchema = {
  IGDB_CLIENT_ID: Joi.string().required(),
  IGDB_CLIENT_SECRET: Joi.string().required(),

  // The client secret travels in the token request's query string, so plain
  // http is allowed only to this machine, where the e2e suite's endpoint runs.
  IGDB_TOKEN_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .custom((value: string, helpers) => {
      const url = new URL(value);

      return url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)
        ? helpers.message({ custom: '{{#label}} must use https unless it points at this machine' })
        : value;
    }),
};
