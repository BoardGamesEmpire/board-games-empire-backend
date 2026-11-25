import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface SwaggerConfig {
  basePath: string;
  description: string;
  title: string;
  version: string;
}

/**
 * The API document's header. The document is always served, on the
 * operational port (#1511), so nothing turns it on or off.
 */
export default registerAs('swagger', () =>
  env.provideMany<SwaggerConfig>([
    {
      key: 'SWAGGER_TITLE',
      keyTo: 'title',
      defaultValue: 'Board Games Empire API',
    },
    {
      key: 'SWAGGER_DESCRIPTION',
      keyTo: 'description',
      defaultValue: 'RESTful API for Board Games Empire',
    },
    {
      key: 'SWAGGER_VERSION',
      keyTo: 'version',
      defaultValue: '1.0.0',
    },
  ]),
);

/**
 * No defaults here: a Joi default is written into the environment ahead of the
 * config and overrides it (#626). Each accepts `''`, which `@bge/env` reads as
 * unset.
 */
export const swaggerConfigValidationSchema = {
  SWAGGER_TITLE: Joi.string().allow(''),
  SWAGGER_DESCRIPTION: Joi.string().allow(''),
  SWAGGER_VERSION: Joi.string().allow(''),
};
