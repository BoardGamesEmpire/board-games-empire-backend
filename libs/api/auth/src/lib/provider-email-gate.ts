import type { I18nPath } from '@bge/i18n';
import { APIError } from 'better-auth/api';
import { idsAllowingUnverifiedEmail, type OidcProviderConfig } from './configuration/oidc-providers';
import { isProviderSignInPath } from './provider-picture';

export const SIGN_IN_PROVIDER_EMAIL_UNVERIFIED = 'SIGN_IN_PROVIDER_EMAIL_UNVERIFIED';

const MESSAGE: I18nPath = 'errors.auth.sign_in_provider_email_unverified';

/** The slice of better-auth's endpoint context the gate reads. It is `null` outside an endpoint. */
export interface ProviderEmailGateContext {
  readonly path?: string;
  /** The callback's path parameters: `id`, the sign-in provider's id, on `/callback/:id` (#1016). */
  readonly params?: { readonly id?: string };
}

/**
 * `databaseHooks.user.create.before`: refuses a first sign-in whose email the
 * sign-in provider does not vouch for, `email_verified` false or missing
 * (#912). Without that, anyone a provider lets enrol under an address they
 * don't hold could register that address here before its owner, who could
 * then neither sign up with it nor be told why.
 *
 * A provider whose `allowUnverifiedEmail` is on is let through, and its user
 * is created with `emailVerified` false, as everything that trusts an address
 * checks. A provider the config doesn't list, such as a social provider's
 * path, is never let through unverified. A sign-in to an existing user and a
 * link from a signed-in session create no user, so they never reach here.
 *
 * On an OAuth callback better-auth hands the client the refusal's code as the
 * redirect's `error`, and its message as `error_description` (#1016).
 *
 * Only `/callback/:id` names its provider in `params`. `/sign-in/social` names
 * it in `body.provider`, so a user created there counts as unlisted and is
 * refused unverified, whatever the provider's setting. The ID token gate keeps
 * sign-in providers' tokens off that route, and native apps sign in through
 * the redirect flow by app sign-in (#1019), so their users are created on the
 * callback too. A change that let a token through there would have to read
 * the provider from the body.
 */
export function createProviderEmailGate(
  providers: readonly Pick<OidcProviderConfig, 'id' | 'allowUnverifiedEmail'>[],
  render: (key: I18nPath) => string,
): (user: { readonly emailVerified?: unknown }, context: ProviderEmailGateContext | null) => void {
  const lenient = new Set(idsAllowingUnverifiedEmail(providers));

  return (user, context) => {
    if (context === null || !isProviderSignInPath(context) || user.emailVerified === true) {
      return;
    }

    const providerId = context.params?.id;

    if (providerId !== undefined && lenient.has(providerId)) {
      return;
    }

    throw new APIError('FORBIDDEN', { code: SIGN_IN_PROVIDER_EMAIL_UNVERIFIED, message: render(MESSAGE) });
  };
}
