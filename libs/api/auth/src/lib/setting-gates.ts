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

/**
 * Routes refused before their handler runs, by better-auth endpoint path.
 *
 * Email sign-up is here as well as behind {@link SettingGates.beforeUserCreate}
 * because its handler looks the email up before it creates anything, and
 * answers `USER_ALREADY_EXISTS` for a registered one. Left to the create hook
 * alone, a closed server would tell a caller which emails hold accounts, at no
 * cost and with nothing written.
 */
const ROUTE_GATES: ReadonlyMap<string, Gate> = new Map([['/sign-up/email', REGISTRATION]]);

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

/** The slice of better-auth's endpoint context the gates read. It is `null` outside an endpoint. */
export interface SettingGateContext {
  readonly path?: string;
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
  const refuseUnlessAllowed = async (gate: Gate, path?: string): Promise<void> => {
    const switches = await deps.readSwitches();
    if (switches?.[gate.switch]) {
      return;
    }

    const message = path !== undefined && OAUTH_CALLBACK_PATHS.has(path) ? gate.code : deps.render(gate.message);
    throw new APIError('FORBIDDEN', { code: gate.code, message });
  };

  return {
    async beforeUserCreate(_user, context) {
      if (context?.path === ADMIN_CREATE_USER_PATH) {
        return;
      }

      await refuseUnlessAllowed(REGISTRATION, context?.path);
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
