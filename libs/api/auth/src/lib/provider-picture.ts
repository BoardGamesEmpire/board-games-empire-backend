/**
 * The better-auth endpoints that could create a user from what a sign-in
 * provider vouches for: the OAuth callback, an ID token sent to social sign-in,
 * and Google One Tap. Only the callback does today, app sign-in's included
 * (#1019). The ID token gate refuses sign-in providers' tokens on social
 * sign-in, and One Tap has no Google client id. They stay listed so the email
 * gate holds if either opens.
 */
const PROVIDER_SIGN_IN_PATHS: ReadonlySet<string> = new Set(['/callback/:id', '/sign-in/social', '/one-tap/callback']);

/** The slice of better-auth's endpoint context the hook reads. It is `null` outside an endpoint. */
export interface ProviderPictureContext {
  readonly path?: string;
}

/** Whether the endpoint creating a user is one a sign-in provider vouches for (#695, #912). */
export function isProviderSignInPath(context: ProviderPictureContext | null): boolean {
  return context?.path !== undefined && PROVIDER_SIGN_IN_PATHS.has(context.path);
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

  return isProviderSignInPath(context) ? undefined : { data: { image: null } };
}
