import { ProviderLinkingPolicy, type PrismaClient } from '@bge/database';
import type { I18nPath } from '@bge/i18n';
import {
  createProviderLinkingGate,
  providerLinkingPolicyReader,
  type ProviderLinkingGateDeps,
} from './provider-linking-gate';

const render = (key: I18nPath): string => `rendered:${key}`;

const NEEDS_SIGN_IN = {
  error: 'account_not_linked',
  errorDescription: render('errors.auth.provider_link_needs_sign_in'),
};

const EMAIL_UNVERIFIED = {
  error: 'account_not_linked',
  errorDescription: render('errors.auth.provider_link_email_unverified'),
};

/** A provider sign-in's OAuth state on the callback: no `link`, since no signed-in user started it. */
const SIGN_IN_STATE = { callbackURL: '/', codeVerifier: 'verifier' };

/** The state of a link a signed-in user started from `/link-social`. */
const LINK_STATE = { callbackURL: '/', codeVerifier: 'verifier', link: { userId: 'u', email: 'e' } };

/** A gate over the given policy and OAuth state, with the mocks it reads them through. */
const gateOver = (
  policy: ProviderLinkingPolicy | null,
  state: Readonly<Record<string, unknown>> | null = SIGN_IN_STATE,
  overrides: Partial<ProviderLinkingGateDeps> = {},
) => {
  const deps = {
    readPolicy: jest.fn(async () => policy),
    readOAuthState: jest.fn(async () => state),
    render,
    ...overrides,
  };

  return { gate: createProviderLinkingGate(deps), deps };
};

/** What better-auth hands the gate for a link: the provider's claims, mapped, and the action. */
const linking = (user: { readonly emailVerified?: unknown }) => ({ user, source: { action: 'link-account' } });

describe('createProviderLinkingGate', () => {
  it('leaves every action but link-account alone (#913)', async () => {
    const { gate, deps } = gateOver(ProviderLinkingPolicy.SignedIn);

    for (const action of ['create-user', 'sign-in']) {
      await expect(gate({ user: { emailVerified: false }, source: { action } })).resolves.toBeUndefined();
    }
    expect(deps.readPolicy).not.toHaveBeenCalled();
  });

  // `link` rides the OAuth state only when a signed-in user started the flow
  // from `/link-social`; better-auth writes it after the client's
  // `additionalData`, so a client can't set it.
  it('lets an explicit link through, whatever the policy (#913)', async () => {
    for (const policy of [ProviderLinkingPolicy.SignedIn, ProviderLinkingPolicy.AutomaticWhenVerified, null]) {
      const { gate } = gateOver(policy, LINK_STATE);

      await expect(gate(linking({ emailVerified: false }))).resolves.toBeUndefined();
    }
  });

  it('refuses a link a sign-in makes itself under SignedIn, with account_not_linked and the sign-in message (#913)', async () => {
    const { gate } = gateOver(ProviderLinkingPolicy.SignedIn);

    await expect(gate(linking({ emailVerified: true }))).resolves.toEqual(NEEDS_SIGN_IN);
  });

  it('refuses a link a sign-in makes itself when the row is missing (#913)', async () => {
    const { gate } = gateOver(null);

    await expect(gate(linking({ emailVerified: true }))).resolves.toEqual(NEEDS_SIGN_IN);
  });

  // A link made on a route with no redirect flow, such as `/sign-in/social`
  // with an ID token, has no OAuth state at all. The gate reads the action and
  // the state, never the path, so that link meets the policy too.
  it('refuses a link a sign-in makes itself with no OAuth state (#913)', async () => {
    const signedIn = gateOver(ProviderLinkingPolicy.SignedIn, null);
    await expect(signedIn.gate(linking({ emailVerified: true }))).resolves.toEqual(NEEDS_SIGN_IN);

    const automatic = gateOver(ProviderLinkingPolicy.AutomaticWhenVerified, null);
    await expect(automatic.gate(linking({ emailVerified: true }))).resolves.toBeUndefined();
  });

  it('links automatically when the provider confirms the email (#913)', async () => {
    const { gate } = gateOver(ProviderLinkingPolicy.AutomaticWhenVerified);

    await expect(gate(linking({ emailVerified: true }))).resolves.toBeUndefined();
  });

  // better-auth lets a provider it trusts for linking, one the operator allows
  // unverified emails for, past its own check on the provider's email. So the
  // gate's check is the only one such a provider meets.
  it('refuses an automatic link the provider does not confirm, whatever the trusted list says (#913)', async () => {
    const { gate } = gateOver(ProviderLinkingPolicy.AutomaticWhenVerified);

    for (const user of [{ emailVerified: false }, {}, { emailVerified: 'true' }]) {
      await expect(gate(linking(user))).resolves.toEqual(EMAIL_UNVERIFIED);
    }
  });

  // better-auth refuses the sign-in when the gate throws, so a read that fails
  // must reach it rather than be taken for a policy.
  it('refuses when the policy cannot be read (#913)', async () => {
    const { gate } = gateOver(ProviderLinkingPolicy.AutomaticWhenVerified, SIGN_IN_STATE, {
      readPolicy: jest.fn(async () => {
        throw new Error('connection lost');
      }),
    });

    await expect(gate(linking({ emailVerified: true }))).rejects.toThrow('connection lost');
  });
});

describe('providerLinkingPolicyReader', () => {
  const prismaReading = (row: { providerLinkingPolicy: ProviderLinkingPolicy } | null) => ({
    systemSetting: { findUnique: jest.fn().mockResolvedValue(row) },
  });

  it('reads the policy off the singleton row (#913)', async () => {
    const prisma = prismaReading({ providerLinkingPolicy: ProviderLinkingPolicy.AutomaticWhenVerified });

    await expect(providerLinkingPolicyReader(prisma as unknown as PrismaClient)()).resolves.toBe(
      ProviderLinkingPolicy.AutomaticWhenVerified,
    );
    expect(prisma.systemSetting.findUnique).toHaveBeenCalledWith({
      where: { singleton: true },
      select: { providerLinkingPolicy: true },
    });
  });

  it('reads no policy when the row is missing (#913)', async () => {
    await expect(providerLinkingPolicyReader(prismaReading(null) as unknown as PrismaClient)()).resolves.toBeNull();
  });
});
