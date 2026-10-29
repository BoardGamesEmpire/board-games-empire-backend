import { env } from '@bge/env';
import { EnviratorError, MissingEnvironmentError } from '@status/envirator';
import Joi from 'joi';

/** One sign-in provider the operator configured (#912). */
export interface OidcProviderConfig {
  readonly id: string;
  readonly discoveryUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly displayName: string;
  /**
   * Whether a first sign-in may create a user from an email this provider
   * does not vouch for (`email_verified` false or missing). Off unless the
   * operator turns it on: such an email may not be the user's own.
   */
  readonly allowUnverifiedEmail: boolean;
}

/**
 * The id is the callback path (`/api/auth/oauth2/callback/<id>`), so it stays
 * URL-safe. Upper-casing and turning `-` into `_` then gives each id its own
 * variable segment, which a wider alphabet would not (`a_b` and `a-b`).
 */
export const OIDC_PROVIDER_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * The four variables each listed provider needs, as `OIDC_<SEG>_<suffix>`, in
 * the order a missing one is reported.
 */
const PROVIDER_VARIABLE_SUFFIXES = ['DISCOVERY_URL', 'CLIENT_ID', 'CLIENT_SECRET', 'DISPLAY_NAME'] as const;

type ProviderVariableSuffix = (typeof PROVIDER_VARIABLE_SUFFIXES)[number];

/** The provider's optional variable: `true` or `false`, and unset means `false`. */
const ALLOW_UNVERIFIED_EMAIL_SUFFIX = 'ALLOW_UNVERIFIED_EMAIL';

const PROVIDER_VARIABLE_PATTERN = new RegExp(
  `^OIDC_([A-Z0-9_]+)_(?:${[...PROVIDER_VARIABLE_SUFFIXES, ALLOW_UNVERIFIED_EMAIL_SUFFIX].join('|')})$`,
);

// http(s) only: the api fetches it at sign-in and publishes it in discovery
// for clients to fetch, so `file:` or `javascript:` would boot and fail later.
const DISCOVERY_URL_RULE = Joi.string().uri({ scheme: ['http', 'https'] });

const FLAG_RULE = Joi.boolean();

/** Why a set variable was refused, by what it is meant to hold. */
function malformedReason(key: string): string {
  return key.endsWith(`_${ALLOW_UNVERIFIED_EMAIL_SUFFIX}`)
    ? 'is neither true nor false'
    : 'is not an http or https URL';
}

/** `google-work` becomes `GOOGLE_WORK`, the middle of that provider's variable names. */
export function oidcVariableSegment(id: string): string {
  return id.toUpperCase().replaceAll('-', '_');
}

/**
 * Thrown when `OIDC_PROVIDERS` holds a bad id or a listed provider's variable
 * is malformed, together with any variable a valid id lacks, so the
 * operator fixes everything in one pass. A boot with only missing variables
 * throws envirator's own `MissingEnvironmentError` instead.
 */
export class OidcProvidersConfigError extends EnviratorError {
  constructor(
    readonly invalidIds: readonly string[],
    readonly duplicateIds: readonly string[],
    readonly missingKeys: readonly string[],
    readonly malformedKeys: readonly string[],
  ) {
    super(
      [
        ...invalidIds.map(
          (id) => `OIDC_PROVIDERS: ${JSON.stringify(id)} is not a valid id; use lowercase letters, digits and hyphens`,
        ),
        ...duplicateIds.map((id) => `OIDC_PROVIDERS: ${JSON.stringify(id)} is listed more than once`),
        ...missingKeys.map((key) => `Missing environment variable: '${key}'`),
        ...malformedKeys.map((key) => `${key} ${malformedReason(key)}`),
      ].join('\n'),
    );
  }
}

/**
 * Reads `OIDC_PROVIDERS` and each listed provider's four variables, and its
 * optional `ALLOW_UNVERIFIED_EMAIL`, in list order. Unset or empty means no
 * providers (#912).
 *
 * `@bge/env` reads an empty value as unset, so `defaultValue: ''` hands back
 * `''` for both without a warning, and this collects every missing key itself
 * instead of stopping at the first. Values come back trimmed: a secret
 * mounted from a file often ends in a newline, which the provider would
 * refuse as part of the secret.
 *
 * A listed provider's discovery URL must be an http or https URL, and its
 * `ALLOW_UNVERIFIED_EMAIL`, when set, `true` or `false`. Those checks are here
 * rather than in the api's root schema, which can't tell a listed provider's
 * variable from an unlisted one, and an unlisted one only warns. They
 * therefore run only once the root schema passes.
 */
export function readOidcProviders(): OidcProviderConfig[] {
  // Split without filtering: an empty entry, as a trailing comma leaves, is a
  // bad id rather than something to drop silently.
  const list = env.provide<string>('OIDC_PROVIDERS', { defaultValue: '' }).trim();
  const ids = list.length === 0 ? [] : list.split(',').map((id) => id.trim());

  const invalidIds = ids.filter((id) => !OIDC_PROVIDER_ID_PATTERN.test(id));
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const validIds = ids.filter((id) => OIDC_PROVIDER_ID_PATTERN.test(id));

  const missingKeys: string[] = [];
  const malformedKeys: string[] = [];
  const providers: OidcProviderConfig[] = [];

  for (const id of new Set(validIds)) {
    const segment = oidcVariableSegment(id);
    const key = (suffix: ProviderVariableSuffix) => `OIDC_${segment}_${suffix}`;
    const values = {} as Record<ProviderVariableSuffix, string>;

    // Read in the order a missing key is reported.
    for (const suffix of PROVIDER_VARIABLE_SUFFIXES) {
      values[suffix] = env.provide<string>(key(suffix), { defaultValue: '' }).trim();

      if (values[suffix].length === 0) {
        missingKeys.push(key(suffix));
      }
    }

    // A missing URL is reported as missing only.
    if (values.DISCOVERY_URL.length > 0 && DISCOVERY_URL_RULE.validate(values.DISCOVERY_URL).error !== undefined) {
      malformedKeys.push(key('DISCOVERY_URL'));
    }

    // A mistyped value refuses the boot rather than falling back to off, so a
    // provider the operator meant to trust doesn't refuse sign-ins unexplained.
    const allowKey = `OIDC_${segment}_${ALLOW_UNVERIFIED_EMAIL_SUFFIX}`;
    const allowValue = env.provide<string>(allowKey, { defaultValue: '' }).trim();
    const allow = FLAG_RULE.validate(allowValue.length === 0 ? false : allowValue);

    if (allow.error !== undefined) {
      malformedKeys.push(allowKey);
    }

    providers.push({
      id,
      discoveryUrl: values.DISCOVERY_URL,
      clientId: values.CLIENT_ID,
      clientSecret: values.CLIENT_SECRET,
      displayName: values.DISPLAY_NAME,
      allowUnverifiedEmail: allow.value === true,
    });
  }

  if (invalidIds.length > 0 || duplicateIds.length > 0 || malformedKeys.length > 0) {
    throw new OidcProvidersConfigError(invalidIds, duplicateIds, missingKeys, malformedKeys);
  }

  if (missingKeys.length > 0) {
    throw new MissingEnvironmentError(missingKeys);
  }

  return providers;
}

/**
 * The provider variables whose segment belongs to no listed id: a typo in an
 * id or a variable name, which would otherwise leave a provider silently off.
 * Sorted. Pure, so the caller with a logger does the warning.
 */
export function unlistedOidcVariables(
  environment: Readonly<Record<string, string | undefined>>,
  ids: readonly string[],
): string[] {
  const listed = new Set(ids.map(oidcVariableSegment));

  return Object.keys(environment)
    .filter((key) => {
      const segment = PROVIDER_VARIABLE_PATTERN.exec(key)?.[1];
      return segment !== undefined && !listed.has(segment);
    })
    .sort();
}
