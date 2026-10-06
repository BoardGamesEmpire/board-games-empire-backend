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
      readUsername: jest.fn(async (userId: string) => (userId === 'u1' ? 'alice' : null)),
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

  describe('beforeUserUpdate (every user update better-auth makes)', () => {
    /** The endpoint context of a signed-in `alice` (`u1`) calling `path`. */
    const signedIn = (path: string) => ({ path, context: { session: { user: { id: 'u1' } } } });

    it('refuses a username change with 403 USERNAME_CHANGE_DISABLED while changes are off', async () => {
      switches = { ...ALL_OPEN, allowUsernameChange: false };

      await expect(refusalOf(gates().beforeUserUpdate({ name: 'mallory' }, signedIn('/update-user')))).resolves.toEqual(
        {
          status: 403,
          code: 'USERNAME_CHANGE_DISABLED',
          message: 'rendered:errors.auth.username_change_disabled',
        },
      );
    });

    it('lets a username change through while changes are on, without looking the user up', async () => {
      await expect(gates().beforeUserUpdate({ name: 'mallory' }, signedIn('/update-user'))).resolves.toBeUndefined();
      expect(deps.readUsername).not.toHaveBeenCalled();
    });

    // A client that saves a whole profile form resends the username it
    // already has.
    it('lets the current username through while changes are off', async () => {
      switches = { ...ALL_OPEN, allowUsernameChange: false };

      await expect(
        gates().beforeUserUpdate({ name: 'alice', firstName: 'Alice' }, signedIn('/update-user')),
      ).resolves.toBeUndefined();
    });

    it('lets profile fields through while changes are off, without reading the row', async () => {
      switches = { ...ALL_OPEN, allowUsernameChange: false };

      await expect(
        gates().beforeUserUpdate({ name: undefined, firstName: 'Alice', image: undefined }, signedIn('/update-user')),
      ).resolves.toBeUndefined();
      expect(deps.readSwitches).not.toHaveBeenCalled();
    });

    it('lets an admin change a username while changes are off', async () => {
      switches = { ...ALL_OPEN, allowUsernameChange: false };

      await expect(
        gates().beforeUserUpdate({ name: 'mallory' }, signedIn('/admin/update-user')),
      ).resolves.toBeUndefined();
    });

    it.each([null, { path: '/verify-email' }, { path: '/sign-in/email' }])(
      'leaves an update from %o alone without reading the row',
      async (context) => {
        switches = null;

        await expect(gates().beforeUserUpdate({ name: 'mallory' }, context)).resolves.toBeUndefined();
        expect(deps.readSwitches).not.toHaveBeenCalled();
      },
    );

    it('refuses a username change while the settings row is missing', async () => {
      switches = null;

      await expect(
        refusalOf(gates().beforeUserUpdate({ name: 'mallory' }, signedIn('/update-user'))),
      ).resolves.toMatchObject({ code: 'USERNAME_CHANGE_DISABLED' });
    });

    // `name: null` included: with no username read, null would otherwise
    // compare equal to it and pass.
    it.each([
      ['no session', 'alice', { path: '/update-user', context: { session: null } }],
      ['no session', null, { path: '/update-user', context: { session: null } }],
      ['no such user', null, { path: '/update-user', context: { session: { user: { id: 'gone' } } } }],
    ])(
      'refuses while changes are off when it cannot read the current username (%s, name %p)',
      async (_case, name, context) => {
        switches = { ...ALL_OPEN, allowUsernameChange: false };

        await expect(refusalOf(gates().beforeUserUpdate({ name }, context))).resolves.toMatchObject({
          code: 'USERNAME_CHANGE_DISABLED',
        });
      },
    );
  });

  describe('beforeRoute (refusals ahead of the route handler)', () => {
    it.each(['/request-password-reset', '/reset-password'])(
      'refuses %s with 403 PASSWORD_RESET_DISABLED while resets are off',
      async (path) => {
        switches = { ...ALL_OPEN, allowPasswordResets: false };

        await expect(refusalOf(gates().beforeRoute({ path }))).resolves.toEqual({
          status: 403,
          code: 'PASSWORD_RESET_DISABLED',
          message: 'rendered:errors.auth.password_reset_disabled',
        });
      },
    );

    it.each(['/request-password-reset', '/reset-password'])('lets %s through while resets are on', async (path) => {
      await expect(gates().beforeRoute({ path })).resolves.toBeUndefined();
    });

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

    it.each([
      '/sign-in/email',
      '/get-session',
      '/sign-out',
      '/admin/create-user',
      '/change-password',
      '/admin/set-user-password',
      '/reset-password/:token',
    ])('leaves %s alone without reading the row', async (path) => {
      switches = null;

      await expect(gates().beforeRoute({ path })).resolves.toBeUndefined();
      expect(deps.readSwitches).not.toHaveBeenCalled();
    });
  });
});
