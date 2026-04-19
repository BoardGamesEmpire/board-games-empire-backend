import { env, isTrue } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface DatabaseConfig {
  logQueries: boolean;
  url: string;
}

// TODO: support building the database URL from individual components if DATABASE_URL is not provided
export const databaseConfig = registerAs('database', () =>
  env.provideMany<DatabaseConfig>([
    {
      keyTo: 'url',
      defaultValue: '',
      key: 'DATABASE_URL',
      allowEmptyString: true,
    },
    {
      keyTo: 'logQueries',
      mutators: isTrue,
      defaultValue: false,
      key: 'DATABASE_LOG_QUERIES',
    },
  ]),
);

export const databaseConfigValidationSchema = {
  DATABASE_URL: Joi.string().required(),
  DATABASE_LOG_QUERIES: Joi.bool().optional().default(false),
};
