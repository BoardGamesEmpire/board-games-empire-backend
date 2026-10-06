import { isAPIError } from 'better-auth/api';
import { createSettingGates, type SettingGateDeps, type SettingSwitches } from './setting-gates';

const ALL_OPEN: SettingSwitches = {
  allowUserRegistration: true,
  allowPasswordResets: true,
  allowUsernameChange: true,
};

/** What a refusal carries on the wire, read off the thrown `APIError`. */
async function refusalOf(attempt: Promise<unknown>): Promise<{ status: number; code?: string; message?: string }> {
  const error = await attempt.then(
    () => {
      throw new Error('expected a refusal, but the gate let the request through');
    },
    (thrown: unknown) => thrown,
  );

  if (!isAPIError(error)) {
    throw error;
  }

  const body = error.body as { code?: string; message?: string } | undefined;
  return { status: error.statusCode, code: body?.code, message: body?.message };
}

describe('createSettingGates', () => {
  let switches: SettingSwitches | null;
  let deps: SettingGateDeps;

  beforeEach(() => {
    switches = { ...ALL_OPEN };
    deps = {
      readSwitches: jest.fn(async () => switches),
      render: jest.fn((key: string) => `rendered:${key}`),
    };
  });

  const gates = () => createSettingGates(deps);

  describe('beforeUserCreate (every account creation better-auth makes)', () => {
    it.each(['/sign-up/email', '/sign-in/anonymous', '/oauth2/callback/:providerId', '/one-tap/callback'])(
      'lets %s create an account while registration is open',
      async (path) => {
        await expect(gates().beforeUserCreate({}, { path })).resolves.toBeUndefined();
      },
    );

    it.each(['/sign-up/email', '/sign-in/anonymous', '/one-tap/callback'])(
      'refuses %s with 403 REGISTRATION_DISABLED while registration is closed',
      async (path) => {
        switches = { ...ALL_OPEN, allowUserRegistration: false };

        await expect(refusalOf(gates().beforeUserCreate({}, { path }))).resolves.toEqual({
          status: 403,
          code: 'REGISTRATION_DISABLED',
          message: 'rendered:errors.auth.registration_disabled',
        });
      },
    );

    // An OAuth callback answers with a redirect whose `error` parameter
    // carries the message alone, so there the message is the code.
    it.each(['/oauth2/callback/:providerId', '/callback/:id'])(
      'refuses %s with the code as its message, for the redirect to carry',
      async (path) => {
        switches = { ...ALL_OPEN, allowUserRegistration: false };

        await expect(refusalOf(gates().beforeUserCreate({}, { path }))).resolves.toEqual({
          status: 403,
          code: 'REGISTRATION_DISABLED',
          message: 'REGISTRATION_DISABLED',
        });
      },
    );

    it('lets an admin create an account while registration is closed, without reading the row', async () => {
      switches = { ...ALL_OPEN, allowUserRegistration: false };

      await expect(gates().beforeUserCreate({}, { path: '/admin/create-user' })).resolves.toBeUndefined();
      expect(deps.readSwitches).not.toHaveBeenCalled();
    });

    it('refuses a creation with no endpoint behind it, since nothing says it is an admin one', async () => {
      switches = { ...ALL_OPEN, allowUserRegistration: false };

      await expect(refusalOf(gates().beforeUserCreate({}, null))).resolves.toMatchObject({
        code: 'REGISTRATION_DISABLED',
      });
    });

    it('refuses while the settings row is missing', async () => {
      switches = null;

      await expect(refusalOf(gates().beforeUserCreate({}, { path: '/sign-up/email' }))).resolves.toMatchObject({
        code: 'REGISTRATION_DISABLED',
      });
    });

    it('reads the row on every attempt, so a change applies without a restart', async () => {
      const gate = gates();

      await expect(gate.beforeUserCreate({}, { path: '/sign-up/email' })).resolves.toBeUndefined();

      switches = { ...ALL_OPEN, allowUserRegistration: false };
      await expect(refusalOf(gate.beforeUserCreate({}, { path: '/sign-up/email' }))).resolves.toMatchObject({
        code: 'REGISTRATION_DISABLED',
      });
    });
  });

  describe('beforeRoute (refusals ahead of the route handler)', () => {
    it('refuses email sign-up while registration is closed', async () => {
      switches = { ...ALL_OPEN, allowUserRegistration: false };

      await expect(refusalOf(gates().beforeRoute({ path: '/sign-up/email' }))).resolves.toEqual({
        status: 403,
        code: 'REGISTRATION_DISABLED',
        message: 'rendered:errors.auth.registration_disabled',
      });
    });

    it('lets email sign-up through while registration is open', async () => {
      await expect(gates().beforeRoute({ path: '/sign-up/email' })).resolves.toBeUndefined();
    });

    it.each(['/sign-in/email', '/get-session', '/sign-out', '/admin/create-user'])(
      'leaves %s alone without reading the row',
      async (path) => {
        switches = null;

        await expect(gates().beforeRoute({ path })).resolves.toBeUndefined();
        expect(deps.readSwitches).not.toHaveBeenCalled();
      },
    );
  });
});
