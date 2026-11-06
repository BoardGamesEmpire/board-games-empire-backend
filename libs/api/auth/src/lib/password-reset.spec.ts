import { runWithRequestState } from '@better-auth/core/context';
import type { PrismaClient } from '@bge/database';
import type { MailMessage } from '@bge/mail';
import { Logger } from '@nestjs/common';
import { isAPIError } from 'better-auth/api';
import { createPasswordReset, passwordResetDeps, resetLink, type PasswordResetDeps } from './password-reset';

const CLIENT_RESET = 'https://c.example/reset';
const CALLBACK_URL = `https://api.example/api/auth/reset-password/tok?callbackURL=${encodeURIComponent(CLIENT_RESET)}`;

/** better-auth's origin matcher, trusting only the client's origin. */
const TRUSTED = {
  isTrustedOrigin: jest.fn((url: string) => new URL(url).origin === 'https://c.example'),
};

async function refusalOf(attempt: Promise<unknown>): Promise<{ status: number; code?: string }> {
  const error = await attempt.then(
    () => {
      throw new Error('expected a refusal, but the request went through');
    },
    (thrown: unknown) => thrown,
  );

  if (!isAPIError(error)) {
    throw error;
  }

  return { status: error.statusCode, code: (error.body as { code?: string } | undefined)?.code };
}

describe('resetLink', () => {
  it.each([
    ['https://c.example/reset', 'https://c.example/reset#token=tok'],
    // The query survives and the old fragment is replaced (#654).
    ['https://c.example/reset?lang=fr#old', 'https://c.example/reset?lang=fr#token=tok'],
    ['bge://reset', 'bge://reset#token=tok'],
  ])('turns %s into %s', (redirectTo, expected) => {
    expect(resetLink(redirectTo, 'tok')).toBe(expected);
  });
});

describe('createPasswordReset', () => {
  let state: { configured: boolean; lifetimeMinutes: number } | null;
  let deps: jest.Mocked<PasswordResetDeps>;
  let sent: Array<[string, MailMessage]>;
  let logged: unknown[][];

  beforeEach(() => {
    state = { configured: true, lifetimeMinutes: 1440 };
    sent = [];
    logged = [];
    deps = {
      readMailState: jest.fn(async () => state),
      enqueue: jest.fn(async (id: string, message: MailMessage) => {
        sent.push([id, message]);
      }),
      render: jest.fn((key) => key),
      now: jest.fn(() => new Date('2026-11-05T00:00:00Z')),
    };
    jest.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => void logged.push(args));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => void logged.push(args));
  });

  afterEach(() => jest.restoreAllMocks());

  describe('beforeRoute on /request-password-reset', () => {
    it.each([
      ['no redirectTo', {}],
      ['an empty redirectTo', { redirectTo: '' }],
      ['a relative redirectTo', { redirectTo: '/reset' }],
    ])('refuses %s before any token is minted (#654)', async (_name, body) => {
      const { beforeRoute } = createPasswordReset(deps);

      await expect(refusalOf(beforeRoute({ path: '/request-password-reset', body }))).resolves.toEqual({
        status: 400,
        code: 'PASSWORD_RESET_REDIRECT_REQUIRED',
      });
    });

    // The link hands its token to redirectTo, so it must be a trusted origin
    // even when DISABLE_ORIGIN_CHECK turns off better-auth's own check (#654).
    it('refuses a redirectTo outside the trusted origins, reading nothing (#654)', async () => {
      const { beforeRoute } = createPasswordReset(deps);

      await expect(
        refusalOf(
          beforeRoute({
            path: '/request-password-reset',
            body: { redirectTo: 'https://evil.example/' },
            context: TRUSTED,
          }),
        ),
      ).resolves.toEqual({ status: 403, code: 'PASSWORD_RESET_REDIRECT_UNTRUSTED' });
      expect(TRUSTED.isTrustedOrigin).toHaveBeenCalledWith('https://evil.example/', { allowRelativePaths: false });
      expect(deps.readMailState).not.toHaveBeenCalled();
    });

    it('refuses when no origin matcher is at hand, rather than trust any address (#654)', async () => {
      const { beforeRoute } = createPasswordReset(deps);

      await expect(
        refusalOf(beforeRoute({ path: '/request-password-reset', body: { redirectTo: CLIENT_RESET } })),
      ).resolves.toEqual({ status: 403, code: 'PASSWORD_RESET_REDIRECT_UNTRUSTED' });
    });

    it('refuses with MAIL_NOT_CONFIGURED when mail is not set up (#654)', async () => {
      state = { configured: false, lifetimeMinutes: 1440 };
      const { beforeRoute } = createPasswordReset(deps);

      await expect(
        refusalOf(
          beforeRoute({ path: '/request-password-reset', body: { redirectTo: CLIENT_RESET }, context: TRUSTED }),
        ),
      ).resolves.toEqual({ status: 403, code: 'MAIL_NOT_CONFIGURED' });
    });

    it('refuses with MAIL_NOT_CONFIGURED when the row is missing (#654)', async () => {
      state = null;
      const { beforeRoute } = createPasswordReset(deps);

      await expect(
        refusalOf(
          beforeRoute({ path: '/request-password-reset', body: { redirectTo: CLIENT_RESET }, context: TRUSTED }),
        ),
      ).resolves.toEqual({ status: 403, code: 'MAIL_NOT_CONFIGURED' });
    });

    it('lets a configured server through (#654)', async () => {
      const { beforeRoute } = createPasswordReset(deps);

      await expect(
        beforeRoute({ path: '/request-password-reset', body: { redirectTo: CLIENT_RESET }, context: TRUSTED }),
      ).resolves.toBeUndefined();
    });
  });

  it.each(['/reset-password', '/sign-in/email', undefined])(
    'beforeRoute on %s reads nothing, because finishing a reset needs no mail (#654)',
    async (path) => {
      const { beforeRoute } = createPasswordReset(deps);

      await expect(beforeRoute({ path, body: {} })).resolves.toBeUndefined();
      expect(deps.readMailState).not.toHaveBeenCalled();
    },
  );

  // The verification hook and sendResetPassword run only for a registered
  // address. A read of their own in each would make those answers slower,
  // which shows which addresses hold accounts (#654).
  it('reads the settings row once across one request, however many hooks need it (#654)', async () => {
    const reset = createPasswordReset(deps);

    await runWithRequestState(new WeakMap(), async () => {
      await reset.beforeRoute({
        path: '/request-password-reset',
        body: { redirectTo: CLIENT_RESET },
        context: TRUSTED,
      });
      await reset.beforeVerificationCreate({ identifier: 'reset-password:tok' });
      await reset.sendResetPassword({ user: { id: 'u1' }, url: CALLBACK_URL, token: 'tok' });
    });

    expect(deps.readMailState).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it('reads the settings row again for the next request (#654)', async () => {
    const { beforeVerificationCreate } = createPasswordReset(deps);

    await runWithRequestState(new WeakMap(), () => beforeVerificationCreate({ identifier: 'reset-password:a' }));
    await runWithRequestState(new WeakMap(), () => beforeVerificationCreate({ identifier: 'reset-password:b' }));

    expect(deps.readMailState).toHaveBeenCalledTimes(2);
  });

  describe('sendResetPassword', () => {
    it('queues the client link with the lifetime from the settings, and when it expires (#654)', async () => {
      const { sendResetPassword } = createPasswordReset(deps);

      await sendResetPassword({ user: { id: 'u1' }, url: CALLBACK_URL, token: 'tok' });

      expect(sent).toEqual([
        [
          'u1',
          {
            kind: 'password-reset',
            link: 'https://c.example/reset#token=tok',
            lifetimeMinutes: 1440,
            expiresAt: '2026-11-06T00:00:00.000Z',
          },
        ],
      ]);
    });

    // The worker drops a reset past this time, so it must be the token's own
    // expiry, not one worked out again when the mail is queued (#654).
    it('carries the expiry the verification hook gave the token, within one request (#654)', async () => {
      const { beforeVerificationCreate, sendResetPassword } = createPasswordReset(deps);

      await runWithRequestState(new WeakMap(), async () => {
        await beforeVerificationCreate({ identifier: 'reset-password:tok' });
        deps.now.mockReturnValue(new Date('2026-11-05T00:00:05Z'));
        await sendResetPassword({ user: { id: 'u1' }, url: CALLBACK_URL, token: 'tok' });
      });

      expect(sent).toEqual([['u1', expect.objectContaining({ expiresAt: '2026-11-06T00:00:00.000Z' })]]);
    });

    // While Redis refuses connections `queue.add` waits instead of rejecting;
    // awaiting it would hang the response for registered addresses only (#654).
    it('resolves while the queue never answers, so the response is not held for a registered address (#654)', async () => {
      deps.enqueue.mockReturnValue(new Promise<void>(() => undefined));
      const { sendResetPassword } = createPasswordReset(deps);

      await expect(sendResetPassword({ user: { id: 'u1' }, url: CALLBACK_URL, token: 'tok' })).resolves.toBeUndefined();

      expect(deps.enqueue).toHaveBeenCalledTimes(1);
    });

    it('logs neither token, link nor message when queueing later fails (#654)', async () => {
      deps.enqueue.mockRejectedValue(new Error(`redis down while adding ${CLIENT_RESET}#token=tok`));
      const { sendResetPassword } = createPasswordReset(deps);

      await expect(sendResetPassword({ user: { id: 'u1' }, url: CALLBACK_URL, token: 'tok' })).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));

      const text = JSON.stringify(logged);
      expect(logged.length).toBeGreaterThan(0);
      expect(text).not.toContain('tok');
      expect(text).not.toContain('c.example');
      expect(text).not.toContain('redis down');
      expect(text).toContain('Error');
    });

    it('logs a settings failure as one, and queues nothing (#654)', async () => {
      deps.readMailState.mockRejectedValue(new TypeError('db down'));
      const { sendResetPassword } = createPasswordReset(deps);

      await sendResetPassword({ user: { id: 'u1' }, url: CALLBACK_URL, token: 'tok' });

      expect(deps.enqueue).not.toHaveBeenCalled();
      expect(JSON.stringify(logged)).toContain('could not read the mail settings (TypeError)');
    });

    // A bad URL is not a settings problem; saying so would send an operator
    // to the database instead (#654).
    it('logs a link it cannot build as a link failure, not a settings one (#654)', async () => {
      const { sendResetPassword } = createPasswordReset(deps);

      await sendResetPassword({ user: { id: 'u1' }, url: 'not a url', token: 'tok' });

      const text = JSON.stringify(logged);
      expect(deps.enqueue).not.toHaveBeenCalled();
      expect(text).toContain('could not build the reset link (TypeError)');
      expect(text).not.toContain('mail settings');
    });

    it('queues nothing, and logs neither token nor link, when the row is missing (#654)', async () => {
      state = null;
      const { sendResetPassword } = createPasswordReset(deps);

      await expect(sendResetPassword({ user: { id: 'u1' }, url: CALLBACK_URL, token: 'tok' })).resolves.toBeUndefined();

      expect(deps.enqueue).not.toHaveBeenCalled();
      expect(JSON.stringify(logged)).not.toContain('tok');
    });
  });

  describe('beforeVerificationCreate', () => {
    it('expires a reset token after the lifetime in the settings (#654)', async () => {
      state = { configured: true, lifetimeMinutes: 60 };
      const { beforeVerificationCreate } = createPasswordReset(deps);

      await expect(beforeVerificationCreate({ identifier: 'reset-password:abc' })).resolves.toEqual({
        data: { expiresAt: new Date('2026-11-05T01:00:00Z') },
      });
    });

    it('leaves another verification alone (#654)', async () => {
      const { beforeVerificationCreate } = createPasswordReset(deps);

      await expect(beforeVerificationCreate({ identifier: 'email-verification:x' })).resolves.toBeUndefined();
      expect(deps.readMailState).not.toHaveBeenCalled();
    });

    it("leaves a reset token at better-auth's own lifetime when the row is missing (#654)", async () => {
      state = null;
      const { beforeVerificationCreate } = createPasswordReset(deps);

      await expect(beforeVerificationCreate({ identifier: 'reset-password:abc' })).resolves.toBeUndefined();
    });
  });
});

describe('passwordResetDeps', () => {
  it('reads the three mail columns and reports whether mail is configured (#654)', async () => {
    const findUnique = jest.fn(async () => ({
      smtpHost: 'smtp.example',
      mailFromAddress: 'bge@example.com',
      passwordResetLinkLifetimeMinutes: 90,
    }));
    const prisma = { systemSetting: { findUnique } } as unknown as PrismaClient;

    const deps = passwordResetDeps(prisma, { enqueue: jest.fn() });

    await expect(deps.readMailState()).resolves.toEqual({ configured: true, lifetimeMinutes: 90 });
    expect(findUnique).toHaveBeenCalledWith({
      where: { singleton: true },
      select: { smtpHost: true, mailFromAddress: true, passwordResetLinkLifetimeMinutes: true },
    });
  });

  it('reports a missing row as null (#654)', async () => {
    const prisma = { systemSetting: { findUnique: async () => null } } as unknown as PrismaClient;

    await expect(passwordResetDeps(prisma, { enqueue: jest.fn() }).readMailState()).resolves.toBeNull();
  });
});
