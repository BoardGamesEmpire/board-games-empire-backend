import { env, splitTrimFilter } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface SecurityTxtConfig {
  /**
   * One or more contact methods for security disclosures.
   * Each value must be a `mailto:`, `https:`, or `tel:` URI.
   * If empty, /.well-known/security.txt returns 404.
   */
  contact: string[];

  /**
   * Explicit expiry date in ISO 8601 format.
   * If not set, the service auto-computes one year from the current date.
   * Must be a future date — RFC 9116 §2.5.
   */
  expires: string;

  /**
   * URL to the security disclosure policy for this server.
   * Recommended per RFC 9116 §2.4.
   */
  policy: string;

  /**
   * URL to a PGP public key that security researchers should use
   * to encrypt their vulnerability reports.
   * Optional — RFC 9116 §2.3.
   */
  encryption: string;

  /**
   * URL to a page acknowledging researchers who have reported vulnerabilities.
   * Optional — RFC 9116 §2.6.
   */
  acknowledgments: string;

  /**
   * BCP 47 language tags indicating preferred languages for reports.
   * Comma-separated. Defaults to 'en'.
   * Optional — RFC 9116 §2.7.
   */
  preferredLanguages: string;

  /**
   * URL to security-relevant job postings.
   * Optional — RFC 9116 §2.8.
   */
  hiring: string;
}

export default registerAs('security', () =>
  env.provideMany<SecurityTxtConfig>([
    {
      keyTo: 'contact',
      key: 'SECURITY_CONTACT',
      defaultValue: '',
      allowEmptyString: true,
      mutators: splitTrimFilter,
    },
    {
      keyTo: 'expires',
      key: 'SECURITY_EXPIRES',
      defaultValue: '',
      allowEmptyString: true,
    },
    {
      keyTo: 'policy',
      key: 'SECURITY_POLICY_URL',
      defaultValue: '',
      allowEmptyString: true,
    },
    {
      keyTo: 'encryption',
      key: 'SECURITY_ENCRYPTION_URL',
      defaultValue: '',
      allowEmptyString: true,
    },
    {
      keyTo: 'acknowledgments',
      key: 'SECURITY_ACKNOWLEDGMENTS_URL',
      defaultValue: '',
      allowEmptyString: true,
    },
    {
      keyTo: 'preferredLanguages',
      key: 'SECURITY_PREFERRED_LANGUAGES',
      defaultValue: 'en',
    },
    {
      keyTo: 'hiring',
      key: 'SECURITY_HIRING_URL',
      defaultValue: '',
      allowEmptyString: true,
    },
  ]),
);

export const securityTxtConfigValidationSchema = {
  SECURITY_CONTACT: Joi.string().optional().allow(''),
  SECURITY_EXPIRES: Joi.string().isoDate().optional().allow(''),
  SECURITY_POLICY_URL: Joi.string().uri().optional().allow(''),
  SECURITY_ENCRYPTION_URL: Joi.string().uri().optional().allow(''),
  SECURITY_ACKNOWLEDGMENTS_URL: Joi.string().uri().optional().allow(''),
  SECURITY_PREFERRED_LANGUAGES: Joi.string().optional().default('en'),
  SECURITY_HIRING_URL: Joi.string().uri().optional().allow(''),
};
