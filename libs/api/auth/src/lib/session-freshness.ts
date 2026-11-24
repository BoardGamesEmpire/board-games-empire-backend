/**
 * Whether a session signed in at `signedInAt` is too old for a check that asks
 * for a recent sign-in, by better-auth's own fresh-session rule: a session
 * signed in `freshAgeSeconds` ago or longer is stale, and a `freshAgeSeconds`
 * of 0 checks nothing (#913, #1418).
 *
 * The one rule for every check made outside better-auth's own routes: starting
 * a link to a sign-in provider, and giving an API key a Critical permission.
 * Each check decides for itself what a missing session or sign-in time means.
 */
export function isSessionStale(input: { freshAgeSeconds: number; now: number; signedInAt: Date }): boolean {
  if (input.freshAgeSeconds === 0) {
    return false;
  }

  return input.now - input.signedInAt.getTime() >= input.freshAgeSeconds * 1000;
}
