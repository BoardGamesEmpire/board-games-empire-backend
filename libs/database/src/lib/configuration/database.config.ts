import { env, isTrue } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface DatabaseConfig {
  logQueries: boolean;
  url: string;
  /**
   * The migration credential (#445), read only by the bootstrap: what `prisma
   * migrate deploy` connects with when the migrations have a database role of
   * their own. Empty when unset, and the migrations then use {@link url}.
   */
  migrationUrl: string;
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
      keyTo: 'migrationUrl',
      defaultValue: '',
      key: 'DATABASE_MIGRATION_URL',
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
  // No default: Nest writes Joi defaults into the environment, and an unset
  // migration credential must stay unset for the Prisma CLI too.
  DATABASE_MIGRATION_URL: Joi.string().allow('').optional(),
  DATABASE_LOG_QUERIES: Joi.bool().optional().default(false),
};
