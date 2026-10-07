import type { PrismaClient, SystemSetting } from '@bge/database';
import { FALLBACK_LOCALE, type I18nPath, type I18nTranslations } from '@bge/i18n';
import { Logger } from '@nestjs/common';
import { APIError } from 'better-auth/api';
import type { I18nService } from 'nestjs-i18n';

/**
 * The settings row's switches that better-auth's routes obey (#585). The row
 * is their only source: there is no environment override, and an admin's
 * PATCH applies on the next request because every gate reads the row afresh.
 */
export type SettingSwitches = Pick<
  SystemSetting,
  'allowUserRegistration' | 'allowPasswordResets' | 'allowUsernameChange'
>;

export interface SettingGateDeps {
  /** The row's switches, or `null` when the row is missing. A missing row refuses everything gated. */
  readonly readSwitches: () => Promise<SettingSwitches | null>;
  /** A user's username as stored, or `null` when there is no such user. */
  readonly readUsername: (userId: string) => Promise<string | null>;
  /** Renders a refusal's catalog key. */
  readonly render: (key: I18nPath) => string;
}

interface Gate {
  readonly switch: keyof SettingSwitches;
  readonly code: string;
  readonly message: I18nPath;
}

const REGISTRATION: Gate = {
  switch: 'allowUserRegistration',
  code: 'REGISTRATION_DISABLED',
  message: 'errors.auth.registration_disabled',
};

const PASSWORD_RESET: Gate = {
  switch: 'allowPasswordResets',
  code: 'PASSWORD_RESET_DISABLED',
  message: 'errors.auth.password_reset_disabled',
};

const USERNAME_CHANGE: Gate = {
  switch: 'allowUsernameChange',
  code: 'USERNAME_CHANGE_DISABLED',
  message: 'errors.auth.username_change_disabled',
};

/**
 * Routes refused before their handler runs, by better-auth endpoint path.
 *
 * Email sign-up is here as well as behind {@link SettingGates.beforeUserCreate}
 * because its handler looks the email up before it creates anything, and
 * answers `USER_ALREADY_EXISTS` for a registered one. Left to the create hook
 * alone, a closed server would tell a caller which emails hold accounts, at no
 * cost and with nothing written.
 *
 * Both halves of a password reset are refused, so a link sent before resets
 * were switched off cannot finish one after. Neither `/change-password` nor
 * an admin's `/admin/set-user-password` is a reset, and neither is here.
 */
const ROUTE_GATES: ReadonlyMap<string, Gate> = new Map([
  ['/sign-up/email', REGISTRATION],
  ['/request-password-reset', PASSWORD_RESET],
  ['/reset-password', PASSWORD_RESET],
]);

/** The one account creation a closed server still allows: an admin's, which is how it adds people. */
const ADMIN_CREATE_USER_PATH = '/admin/create-user';

/**
 * The OAuth callbacks, which answer a refused first login with a redirect
 * rather than a body. better-auth keeps only the error's message for that
 * redirect's `error` parameter, with its spaces turned into underscores, so a
 * refusal there carries its code as its message: the client gets
 * `error=REGISTRATION_DISABLED` to match, as it gets `code` in a body.
 */
const OAUTH_CALLBACK_PATHS: ReadonlySet<string> = new Set(['/oauth2/callback/:providerId', '/callback/:id']);

/**
 * The route through which users edit their own profile. better-auth maps its
 * `name` onto our `username` column, so it is also how a username changes. An
 * admin's `/admin/update-user` is not gated.
 */
const UPDATE_USER_PATH = '/update-user';

/**
 * What the update hook returns to drop an unchanged username from the write.
 * better-auth merges a hook's `data` over the pending update, so a key can
 * only be overridden, not removed; its adapter then leaves an `undefined`
 * field out of an update.
 */
const UNCHANGED_NAME = { data: { name: undefined } } as const;

/** The slice of better-auth's endpoint context the gates read. It is `null` outside an endpoint. */
export interface SettingGateContext {
  readonly path?: string;
  readonly context?: {
    /** Set by the route's session middleware. */
    readonly session?: { readonly user: { readonly id: string } } | null;
  };
}

export interface SettingGates {
  /**
   * `databaseHooks.user.create.before`. Every account better-auth creates
   * passes through it: email sign-up, anonymous sign-in, a first OIDC login
   * and one-tap. A refused first OIDC login reaches the client as a redirect
   * with `error=REGISTRATION_DISABLED` (see {@link OAUTH_CALLBACK_PATHS}), and
   * better-auth logs it at error level, as it does any creation that fails on
   * a callback.
   */
  beforeUserCreate(user: unknown, context: SettingGateContext | null): Promise<void>;
  /**
   * `databaseHooks.user.update.before`. Refuses `/update-user` only when it
   * would change the username, so a client that resends the whole profile
   * still saves the other fields. While changes are off, the unchanged
   * username is dropped from that write ({@link UNCHANGED_NAME}).
   */
  beforeUserUpdate(
    data: { readonly name?: unknown; readonly [field: string]: unknown },
    context: SettingGateContext | null,
  ): Promise<typeof UNCHANGED_NAME | undefined>;
  /** `hooks.before`, wrapped in `createAuthMiddleware`. */
  beforeRoute(context: SettingGateContext): Promise<void>;
}

/**
 * Refuses the better-auth routes the settings row switches off, with 403 and
 * a BGE code. The message is rendered here, in the fallback locale, because
 * `/api/auth/*` is mounted ahead of Nest's middleware and interceptors, so no
 * locale is resolved for it and nothing translates the body afterwards.
 */
export function createSettingGates(deps: SettingGateDeps): SettingGates {
  const allows = async (gate: Gate): Promise<boolean> => (await deps.readSwitches())?.[gate.switch] === true;

  const refusal = (gate: Gate, path?: string): APIError =>
    new APIError('FORBIDDEN', {
      code: gate.code,
      message: path !== undefined && OAUTH_CALLBACK_PATHS.has(path) ? gate.code : deps.render(gate.message),
    });

  const refuseUnlessAllowed = async (gate: Gate, path?: string): Promise<void> => {
    if (!(await allows(gate))) {
      throw refusal(gate, path);
    }
  };

  return {
    async beforeUserCreate(_user, context) {
      if (context?.path === ADMIN_CREATE_USER_PATH) {
        return;
      }

      await refuseUnlessAllowed(REGISTRATION, context?.path);
    },

    async beforeUserUpdate(data, context) {
      if (context?.path !== UPDATE_USER_PATH || data.name === undefined || (await allows(USERNAME_CHANGE))) {
        return;
      }

      // Without a current username to compare against, as when there is no
      // session or no such user, the change is refused, whatever name it sets.
      const userId = context.context?.session?.user.id;
      const current = userId === undefined ? null : await deps.readUsername(userId);
      if (current === null || current !== data.name) {
        throw refusal(USERNAME_CHANGE);
      }

      // The name is unchanged, so it is left out of the write. Written back,
      // it would undo an admin's rename that landed after the read above.
      return UNCHANGED_NAME;
    },

    async beforeRoute(context) {
      const gate = context.path === undefined ? undefined : ROUTE_GATES.get(context.path);
      if (gate) {
        await refuseUnlessAllowed(gate);
      }
    },
  };
}

/**
 * The gates' dependencies, from the database and the catalog. Without an
 * `I18nService`, as when the better-auth CLI builds the instance, a refusal
 * carries its catalog key.
 */
export function settingGateDeps(prisma: PrismaClient, i18n?: I18nService<I18nTranslations>): SettingGateDeps {
  const logger = new Logger('SettingGates');

  return {
    readSwitches: () =>
      prisma.systemSetting.findUnique({
        where: { singleton: true },
        select: { allowUserRegistration: true, allowPasswordResets: true, allowUsernameChange: true },
      }),

    // Read from the table rather than the session, whose copy of the user can
    // predate an admin's rename.
    readUsername: async (userId) =>
      (await prisma.user.findUnique({ where: { id: userId }, select: { username: true } }))?.username ?? null,

    // Never throws: a catalog entry that cannot render would otherwise turn
    // the refusal into a 500.
    render: (key) => {
      if (!i18n) {
        return key;
      }

      try {
        return i18n.translate(key, { lang: FALLBACK_LOCALE });
      } catch (error) {
        logger.error(`Could not render '${key}'`, error instanceof Error ? error.stack : error);
        return key;
      }
    },
  };
}
