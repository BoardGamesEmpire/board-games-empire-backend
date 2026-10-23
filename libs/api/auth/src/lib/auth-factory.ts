import { apiKey } from '@better-auth/api-key';
import { passkey } from '@better-auth/passkey';
import { prismaAdapter } from '@better-auth/prisma-adapter';
import type { AuditContextService, SystemActorScope } from '@bge/actor-context';
import type { PrismaClient } from '@bge/database';
import { isTrue, splitTrimFilter } from '@bge/env';
import type { I18nTranslations } from '@bge/i18n';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import {
  admin,
  anonymous,
  bearer,
  deviceAuthorization,
  genericOAuth,
  lastLoginMethod,
  oneTap,
  oneTimeToken,
  openAPI,
  twoFactor,
} from 'better-auth/plugins';
import type { User } from 'better-auth/types';
import type { I18nService } from 'nestjs-i18n';
import process from 'node:process';
import { ADMIN_PLUGIN_OPTIONS } from './access/admin-roles';
import type { AuthStorage } from './auth-storage';
import { betterAuthLogger } from './better-auth-logger';
import { AUTH_BASE_PATH, AUTH_CLIENT_IP_HEADER, AUTH_COOKIE_PREFIX } from './constants';
import { UserCreatedEvent } from './events/auth.events';
import { providerPictureOnly } from './provider-picture';
import { createSettingGates, settingGateDeps } from './setting-gates';
import { createSignOutHook } from './sign-out-hook';

interface UserCreatedHookDeps {
  eventEmitter?: EventEmitter2;
  auditContext?: AuditContextService;
  systemActorScope?: SystemActorScope;
}

/**
 * Builds the better-auth `user.create.after` database hook (#57 emit-site
 * migration). Emits a `UserCreatedEvent` carrying a minimal row snapshot;
 * attribution is never on the payload — the audit listener reads the CLS
 * actor at handle time.
 *
 * Attribution at this emit site is flow-dependent:
 *  - Self-signup (email+password, anonymous sign-in, OAuth first login)
 *    requests carry no session, so `HttpActorMiddleware` populates a NULL
 *    CLS actor. Emitting bare would persist an unattributed audit row AND
 *    raise the admin notification, so those emissions run inside a `system`
 *    actor scope (`auth:user-provisioning`).
 *  - Admin-created users (better-auth admin plugin) run with the admin's
 *    session actor in CLS — that attribution is kept as-is.
 *
 * Exported for unit tests; `authFactory` wires it into `databaseHooks`.
 */
export function createUserCreatedHook(deps: UserCreatedHookDeps): (user: User) => Promise<void> {
  const { eventEmitter, auditContext, systemActorScope } = deps;

  return async (user: User): Promise<void> => {
    if (!eventEmitter) {
      throw new Error('EventEmitter2 not provided to authFactory');
    }

    // The write is better-auth's, not ours — the row's own createdAt stamp is
    // the closest capture of when this unit of work began.
    const initiatedAt = user.createdAt ?? new Date();

    // better-auth surfaces the DB `username` column as `name` (see the
    // `user.fields` mapping below); `isAnonymous` comes from the anonymous
    // plugin. Tolerate both shapes.
    const record = user as User & { username?: string; isAnonymous?: boolean | null };

    const event = new UserCreatedEvent(
      {
        id: user.id,
        username: record.username ?? user.name,
        email: user.email,
        isAnonymous: record.isAnonymous ?? false,
      },
      initiatedAt,
    );

    const emit = (): void => {
      eventEmitter.emit(UserCreatedEvent.eventName, event);
    };

    if (auditContext?.getActor()) {
      // A signed-in creator (e.g. admin plugin) — keep their attribution.
      emit();
      return;
    }

    if (systemActorScope) {
      systemActorScope.run('auth:user-provisioning', emit);
      return;
    }

    // No scope available (factory built without full DI) — emit bare; the
    // audit listener flags it as unattributed and notifies admins.
    emit();
  };
}

export function authFactory(
  prisma: PrismaClient,
  configService?: ConfigService,
  storage?: AuthStorage,
  eventEmitter?: EventEmitter2,
  auditContext?: AuditContextService,
  systemActorScope?: SystemActorScope,
  i18n?: I18nService<I18nTranslations>,
) {
  const logger = new Logger('AuthFactory');
  logger.log(`Initializing BetterAuth with ConfigService: ${configService instanceof ConfigService}`);

  const options = buildOptions(configService);

  const port = configService?.get<number>('system.port') || parseInt(process.env.PORT || '33333', 10);
  const trustedOrigins = options.trusted.map((origin) => origin.replace(/{PORT}\/?$/i, port.toString()));

  logger.log(`Trusted origins set to: ${trustedOrigins.join(', ')}`);

  // Only build the OIDC config when it is actually configured. `buildOIDC`
  // calls `getOrThrow` on the ConfigService path, so calling it
  // unconditionally would crash startup for deployments without OIDC.
  const oidcConfig = hasOIDC(configService) ? buildOIDC(configService) : null;
  if (oidcConfig) {
    logger.log(`Enabling OIDC provider: ${oidcConfig.providerId}`);
  }

  if (options.useEmailPass) {
    logger.log('Enabling Email & Password authentication');
  }

  const gateDeps = settingGateDeps(prisma, i18n);
  const settingGates = createSettingGates(gateDeps);
  const signOutHook = createSignOutHook({ render: gateDeps.render });

  const usingSwagger = configService?.get<boolean>('swagger.enabled');
  if (usingSwagger) {
    logger.log('Enabling OpenAPI plugin for API documentation');
  }

  // TODO: Make plugins configurable
  const plugins = [
    // Impersonation is deliberately blocked, not removed (#408): the role map
    // withholds `user:impersonate`, so `POST /admin/impersonate-user` is denied
    // for every principal while the route and `Session.impersonatedBy` stay in
    // place. `adminUserIds` must never be added here — `hasPermission`
    // short-circuits it ahead of the role map.
    admin(ADMIN_PLUGIN_OPTIONS),
    anonymous(),
    // The plugin's per-key rate limit is off (#529). Its default, 10 requests
    // a day, was every key's limit, since only a server-side call can set one
    // and none does, and a key over it was refused as invalid. The IP
    // throttler still applies to every route. How keys should be limited is
    // #642.
    apiKey({ rateLimit: { enabled: false } }),
    // Without requireSignature: the sign-out hook reads a bearer credential
    // as the plugin does with it off (#487).
    bearer(),
    lastLoginMethod(),
    oneTap(),
    oneTimeToken(),
    passkey(),
    twoFactor(),

    ...(oidcConfig
      ? [
          genericOAuth({
            config: [
              {
                ...oidcConfig,
              },
            ],
          }),
        ]
      : []),

    ...(usingSwagger ? [openAPI()] : []),

    deviceAuthorization({
      verificationUri: '/device',
      // temporary workaround: https://github.com/better-auth/better-auth/issues/9422
      schema: {},
    }),
  ];

  return betterAuth({
    telemetry: { enabled: false },
    logger: betterAuthLogger(new Logger('BetterAuth')),
    advanced: {
      cookiePrefix: AUTH_COOKIE_PREFIX,
      disableOriginCheck: options.disableOriginCheck,
      // Only the address the api wrote (#640). better-auth's default,
      // X-Forwarded-For, is a header a client reaching the api directly can
      // write, and without an address it believes every client shares one
      // rate-limit bucket.
      ipAddress: { ipAddressHeaders: [AUTH_CLIENT_IP_HEADER] },
    },
    basePath: AUTH_BASE_PATH,
    appName: 'BoardGamesEmpire',
    baseURL: `${options.hostUrl}${AUTH_BASE_PATH}`,
    user: {
      fields: {
        name: 'username',
      },
      additionalFields: {
        firstName: {
          type: 'string',
          required: false,
        },
        lastName: {
          type: 'string',
          required: false,
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        await settingGates.beforeRoute(context);
        await signOutHook.beforeRoute(context);
      }),
    },
    experimental: { joins: true },
    secret: options.secret,
    database: prismaAdapter(prisma, {
      debugLogs: configService?.get<boolean>('system.is_production') !== true,
      transaction: false,
      provider: 'postgresql',
    }),
    databaseHooks: {
      user: {
        create: {
          // The registration gate first: a refused sign-up writes nothing,
          // so there is no picture to keep or drop.
          before: async (user, context) => {
            await settingGates.beforeUserCreate(user, context);
            return providerPictureOnly(user, context);
          },
          after: createUserCreatedHook({ eventEmitter, auditContext, systemActorScope }),
        },
        update: {
          before: settingGates.beforeUserUpdate,
        },
        // TODO: clean up API keys on user delete. The upstream better-auth
        // apikey schema dropped the Apikey -> User FK (and its onDelete:
        // Cascade) in favour of an unconstrained `referenceId`, so deleting a
        // user no longer removes their keys. Add a `delete.before`/`after` hook
        // here that runs `prisma.apikey.deleteMany({ where: { referenceId: user.id } })`.
      },
    },
    // Without a storage, as when the better-auth CLI builds the instance,
    // better-auth keeps sessions in the database.
    secondaryStorage: storage,
    emailAndPassword: { enabled: options.useEmailPass },
    trustedOrigins,
    plugins,
  });
}

function buildOptions(configService?: ConfigService) {
  if (configService instanceof ConfigService) {
    const hostUrl = configService.getOrThrow<string>('auth.url');
    const secret = configService.getOrThrow<string>('auth.secret');
    const trusted = configService.getOrThrow<string[]>('auth.trustedOrigins');
    const useEmailPass = configService.getOrThrow<boolean>('auth.useEmailPasswordAuth');
    const disableOriginCheck = configService.get<boolean>('auth.disableOriginCheck');

    return { hostUrl, secret, trusted, useEmailPass, disableOriginCheck };
  }

  const envUrl = process.env.BETTER_AUTH_URL;
  const envSecret = process.env.BETTER_AUTH_SECRET;
  const envOrigins = splitTrimFilter(process.env.TRUSTED_ORIGINS ?? '');
  const envEmailPass = isTrue(process.env.USE_EMAIL_PASSWORD_AUTH);
  const disableOriginCheck = isTrue(process.env.DISABLE_ORIGIN_CHECK);

  return { hostUrl: envUrl, secret: envSecret, trusted: envOrigins, useEmailPass: envEmailPass, disableOriginCheck };
}

function hasOIDC(configService?: ConfigService) {
  if (configService instanceof ConfigService) {
    const wellKnownUrl = configService.get<string>('auth.oidcWellKnownUrl');
    const clientId = configService.get<string>('auth.oidcClientId');
    const clientSecret = configService.get<string>('auth.oidcClientSecret');
    return Boolean(wellKnownUrl && clientId && clientSecret);
  }

  const wellKnownUrl = process.env.OIDC_WELL_KNOWN_URL;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  return Boolean(wellKnownUrl && clientId && clientSecret);
}

function buildOIDC(configService?: ConfigService) {
  const defaultProviderId = 'default-oidc-provider';

  if (configService instanceof ConfigService) {
    const discoveryUrl = configService.getOrThrow<string>('auth.oidcWellKnownUrl');
    const clientId = configService.getOrThrow<string>('auth.oidcClientId');
    const clientSecret = configService.getOrThrow<string>('auth.oidcClientSecret');
    const providerId = configService.get<string>('auth.oidcProviderId') || defaultProviderId;

    return { discoveryUrl, clientId, clientSecret, providerId };
  }

  const discoveryUrl = process.env.OIDC_WELL_KNOWN_URL;
  const clientId = process.env.OIDC_CLIENT_ID || '';
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  const providerId = process.env.OIDC_PROVIDER_ID || defaultProviderId;

  return { discoveryUrl, clientId, clientSecret, providerId };
}
