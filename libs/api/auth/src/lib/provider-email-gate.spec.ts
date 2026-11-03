import { isAPIError } from 'better-auth/api';
import { createProviderEmailGate, SIGN_IN_PROVIDER_EMAIL_UNVERIFIED } from './provider-email-gate';

const CALLBACK = '/callback/:id';

/** What a refusal carries on the wire, read off the thrown `APIError`. */
function refusalOf(attempt: () => void): { status: number; code?: string; message?: string } {
  try {
    attempt();
  } catch (error) {
    if (!isAPIError(error)) {
      throw error;
    }

    const body = error.body as { code?: string; message?: string } | undefined;
    return { status: error.statusCode, code: body?.code, message: body?.message };
  }

  throw new Error('expected a refusal, but the gate let the sign-in through');
}

describe('createProviderEmailGate', () => {
  const gate = createProviderEmailGate(
    [
      { id: 'strict', allowUnverifiedEmail: false },
      { id: 'lenient', allowUnverifiedEmail: true },
    ],
    (key) => `rendered:${key}`,
  );

  const callbackOf = (id: string) => ({ path: CALLBACK, params: { id } });

  it('lets a first sign-in through when the provider vouches for the email (#912)', () => {
    expect(() => gate({ emailVerified: true }, callbackOf('strict'))).not.toThrow();
  });

  // The callback's refusal reaches the client as a redirect: the code as
  // `error`, and the sentence as `error_description` (#1016).
  it.each([
    ['false', false],
    ['missing', undefined],
  ])(
    'refuses a first sign-in whose email_verified is %s, with its code and a rendered message (#912)',
    (_state, emailVerified) => {
      expect(refusalOf(() => gate({ emailVerified }, callbackOf('strict')))).toEqual({
        status: 403,
        code: SIGN_IN_PROVIDER_EMAIL_UNVERIFIED,
        message: 'rendered:errors.auth.sign_in_provider_email_unverified',
      });
    },
  );

  it('lets an unverified email through for a provider the operator allows it for (#912)', () => {
    expect(() => gate({ emailVerified: false }, callbackOf('lenient'))).not.toThrow();
    expect(() => gate({}, callbackOf('lenient'))).not.toThrow();
  });

  // `/sign-in/social` names its provider in the body, not in `params`, so it is
  // never let through unverified. The ID token gate keeps sign-in providers'
  // tokens off that route, and app sign-in creates its users on the callback
  // (#1019).
  it('refuses an unverified email on a provider path the config does not list, with a rendered message (#912)', () => {
    expect(refusalOf(() => gate({ emailVerified: false }, { path: '/sign-in/social' }))).toEqual({
      status: 403,
      code: SIGN_IN_PROVIDER_EMAIL_UNVERIFIED,
      message: 'rendered:errors.auth.sign_in_provider_email_unverified',
    });
  });

  it('refuses an unverified email from a provider id the config does not list (#912)', () => {
    expect(refusalOf(() => gate({ emailVerified: false }, callbackOf('unknown'))).code).toBe(
      SIGN_IN_PROVIDER_EMAIL_UNVERIFIED,
    );
  });

  // An email sign-up is unverified until its owner confirms it; that is not
  // this gate's business.
  it('leaves user creation outside a provider path alone (#912)', () => {
    expect(() => gate({ emailVerified: false }, { path: '/sign-up/email' })).not.toThrow();
    expect(() => gate({ emailVerified: false }, { path: '/admin/create-user' })).not.toThrow();
    expect(() => gate({ emailVerified: false }, null)).not.toThrow();
  });
});
