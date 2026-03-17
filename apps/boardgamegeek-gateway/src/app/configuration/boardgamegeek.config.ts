import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface BoardGameGeekConfig {
  apiKey: string;
}

export default registerAs('boardgamegeek', () =>
  env.provideMany<BoardGameGeekConfig>([
    {
      key: 'BOARDGAMEGEEK_API_KEY',
      keyTo: 'apiKey',
    },
  ]),
);

export const boardGameGeekConfigValidationSchema = {
  BOARDGAMEGEEK_API_KEY: Joi.string().required(),
};
