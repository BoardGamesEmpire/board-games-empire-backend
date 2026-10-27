/**
 * The better-auth endpoints that create a user from what a sign-in provider
 * vouches for: the OAuth callbacks, an ID token sent to social sign-in, and
 * Google One Tap.
 */
const PROVIDER_SIGN_IN_PATHS: ReadonlySet<string> = new Set([
  '/callback/:id',
  '/oauth2/callback/:providerId',
  '/sign-in/social',
  '/one-tap/callback',
]);

/** The slice of better-auth's endpoint context the hook reads. It is `null` outside an endpoint. */
export interface ProviderPictureContext {
  readonly path?: string;
}

/**
 * `databaseHooks.user.create.before`: a new user's `image` is their sign-in
 * provider's picture or nothing (#695).
 *
 * Provisioning seeds the avatar from `image`, and the avatar is shown wherever
 * the user appears. Email sign-up takes `image` from the request body, so
 * there it is a URL the registrant chose. As an avatar, every client showing
 * it would fetch it from that URL's server, which then learns the viewer's
 * address. That is why changing an avatar waits on #829. So a picture from
 * any other path is dropped, a path better-auth adds later included.
 */
export function providerPictureOnly(
  user: { readonly image?: string | null },
  context: ProviderPictureContext | null,
): { data: { image: null } } | undefined {
  if (user.image === undefined || user.image === null) {
    return undefined;
  }

  return context?.path !== undefined && PROVIDER_SIGN_IN_PATHS.has(context.path)
    ? undefined
    : { data: { image: null } };
}
