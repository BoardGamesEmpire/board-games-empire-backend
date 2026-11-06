import { type PrismaClient, ProviderLinkingPolicy } from '@bge/database';
import type { I18nPath } from '@bge/i18n';

/**
 * better-auth's own code for a link it refuses. The gate answers with it too,
 * so a client handles both refusals alike; the message says what to do (#913).
 */
const NOT_LINKED = 'account_not_linked';

const NEEDS_SIGN_IN: I18nPath = 'errors.auth.provider_link_needs_sign_in';
const EMAIL_UNVERIFIED: I18nPath = 'errors.auth.provider_link_email_unverified';

/** The action better-auth names when it is about to link a sign-in provider to an existing user. */
const LINK_ACCOUNT = 'link-account';

export interface ProviderLinkingGateDeps {
  /** The row's policy, or null when the row is missing. */
  readonly readPolicy: () => Promise<ProviderLinkingPolicy | null>;
  /** better-auth's OAuth state for this request: getOAuthState from 'better-auth/api'. */
  readonly readOAuthState: () => Promise<{ readonly link?: unknown } | null>;
  readonly render: (key: I18nPath) => string;
}

/**
 * `user.validateUserInfo`: decides whether a sign-in through a sign-in
 * provider may link that provider to the registered user who has the same
 * email (#913). The provider linking policy on the settings row decides:
 *
 *  - `SignedIn`, the default: never. The user signs in another way, then links
 *    the provider from their sign-in methods.
 *  - `AutomaticWhenVerified`: only when the provider confirms the email.
 *    better-auth has already refused the link unless this server has verified
 *    the registered user's email too.
 *
 * Only `emailVerified === true` counts as the provider confirming it. A
 * provider the operator allows unverified emails for is trusted for linking,
 * and better-auth lets a trusted provider past its own check on the provider's
 * email, so this check is the only one such a provider meets.
 *
 * Why here and not in `databaseHooks.account.create.before`: all three writes
 * of an Account row, a first sign-in's, a signed-in user's link and a link a
 * sign-in makes itself, land on `/callback/:id`, and that hook can't tell them
 * apart. better-auth tells this gate the action, and the flow's OAuth state
 * carries `link` only when a signed-in user started it from `/link-social`;
 * better-auth writes `link` after the client's `additionalData`, so a client
 * can't set it. The gate keys on those two and never on the path, so a link
 * made on another route, such as `/sign-in/social` with an ID token, where
 * there is no OAuth state, meets the policy too.
 *
 * The row is read on every link, so a server admin's change applies to the next
 * sign-in, with no restart. A missing row refuses. A read that fails rejects,
 * and better-auth refuses a sign-in whose gate throws.
 *
 * On the callback, better-auth hands the client a refusal's code as the
 * redirect's `error` and its message as `error_description`.
 */
export function createProviderLinkingGate(
  deps: ProviderLinkingGateDeps,
): (data: {
  readonly user: { readonly emailVerified?: unknown };
  readonly source: { readonly action: string };
}) => Promise<{ error: string; errorDescription: string } | undefined> {
  const refusal = (message: I18nPath) => ({ error: NOT_LINKED, errorDescription: deps.render(message) });

  return async ({ user, source }) => {
    if (source.action !== LINK_ACCOUNT || (await deps.readOAuthState())?.link) {
      return undefined;
    }

    if ((await deps.readPolicy()) !== ProviderLinkingPolicy.AutomaticWhenVerified) {
      return refusal(NEEDS_SIGN_IN);
    }

    return user.emailVerified === true ? undefined : refusal(EMAIL_UNVERIFIED);
  };
}

/** Reads the provider linking policy off the settings row, afresh on each call (#913). */
export function providerLinkingPolicyReader(prisma: PrismaClient): () => Promise<ProviderLinkingPolicy | null> {
  return async () =>
    (
      await prisma.systemSetting.findUnique({
        where: { singleton: true },
        select: { providerLinkingPolicy: true },
      })
    )?.providerLinkingPolicy ?? null;
}
