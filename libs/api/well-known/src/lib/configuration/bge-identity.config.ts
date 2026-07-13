import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

/**
 * Semver, permitting an optional pre-release and/or build-metadata suffix so
 * legitimate bounds like `0.1.0-alpha.3` are accepted (BGE itself versions with
 * `-alpha.N`). A bare `MAJOR.MINOR.PATCH` is the common case.
 */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Trim surrounding whitespace so a whitespace-only value collapses to '' (no bound). */
const trim = (value: string): string => value.trim();

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
      mutators: trim,
    },
    {
      keyTo: 'maxClientVersion',
      key: 'BGE_MAX_CLIENT_VERSION',
      defaultValue: '',
      allowEmptyString: true,
      mutators: trim,
    },
  ]),
);

// `.trim()` normalizes whitespace-only values to '' (which `.allow('')` permits
// as "no bound"); any non-empty value must be semver, so misconfigurations like
// `latest` or `v1` fail fast at boot rather than reaching the discovery document.
const clientVersionBound = Joi.string().trim().pattern(SEMVER_PATTERN).allow('').optional();

export const bgeIdentityConfigValidationSchema = {
  BGE_MIN_CLIENT_VERSION: clientVersionBound,
  BGE_MAX_CLIENT_VERSION: clientVersionBound,
};
