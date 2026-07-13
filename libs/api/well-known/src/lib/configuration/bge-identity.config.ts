import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface BgeIdentityConfig {
  /**
   * Minimum semver client version this server accepts. Clients older than
   * this refuse to proceed past server-add. Empty string means no minimum
   * (advertised as null in the discovery document).
   */
  minClientVersion: string;

  /**
   * Maximum semver client version this server accepts. Clients newer than
   * this refuse to proceed. Empty string means no maximum (advertised as
   * null in the discovery document).
   */
  maxClientVersion: string;
}

export default registerAs('bgeIdentity', () =>
  env.provideMany<BgeIdentityConfig>([
    {
      keyTo: 'minClientVersion',
      key: 'BGE_MIN_CLIENT_VERSION',
      defaultValue: '',
      allowEmptyString: true,
    },
    {
      keyTo: 'maxClientVersion',
      key: 'BGE_MAX_CLIENT_VERSION',
      defaultValue: '',
      allowEmptyString: true,
    },
  ]),
);

export const bgeIdentityConfigValidationSchema = {
  BGE_MIN_CLIENT_VERSION: Joi.string().optional().allow(''),
  BGE_MAX_CLIENT_VERSION: Joi.string().optional().allow(''),
};
