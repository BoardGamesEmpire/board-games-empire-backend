import { apiKey } from '@better-auth/api-key';
import { passkey } from '@better-auth/passkey';
import { prismaAdapter } from '@better-auth/prisma-adapter';
import type { AuditContextService, SystemActorScope } from '@bge/actor-context';
import type { PrismaClient } from '@bge/database';
import { isTrue, splitTrimFilter } from '@bge/env';
import type { Cache } from '@nestjs/cache-manager';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { betterAuth } from 'better-auth';
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
import process from 'node:process';
import { AUTH_BASE_PATH } from './constants';
import { UserCreatedEvent } from './events/auth.events';

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
  cache?: Cache,
  eventEmitter?: EventEmitter2,
  auditContext?: AuditContextService,
  systemActorScope?: SystemActorScope,
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

  const usingSwagger = configService?.get<boolean>('swagger.enabled');
  if (usingSwagger) {
    logger.log('Enabling OpenAPI plugin for API documentation');
  }

  // TODO: Make plugins configurable
  const plugins = [
    admin(),
    anonymous(),
    apiKey(),
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
    advanced: {
      cookiePrefix: 'bge_auth_',
      disableOriginCheck: options.disableOriginCheck,
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
          map: 'first_name',
        },
        lastName: {
          type: 'string',
          required: false,
          map: 'last_name',
        },
      },
    },
    hooks: {},
    experimental: { joins: true },
    url: options.hostUrl,
    secret: options.secret,
    database: prismaAdapter(prisma, {
      debugLogs: configService?.get<boolean>('system.is_production') !== true,
      transaction: false,
      provider: 'postgresql',
    }),
    databaseHooks: {
      user: {
        create: {
          after: createUserCreatedHook({ eventEmitter, auditContext, systemActorScope }),
        },
        // TODO: clean up API keys on user delete. The upstream better-auth
        // apikey schema dropped the Apikey -> User FK (and its onDelete:
        // Cascade) in favour of an unconstrained `referenceId`, so deleting a
        // user no longer removes their keys. Add a `delete.before`/`after` hook
        // here that runs `prisma.apikey.deleteMany({ where: { referenceId: user.id } })`.
      },
    },
    secondaryStorage: cache
      ? {
          get(key: string) {
            return cache.get(`auth_${key}`);
          },
          set(key: string, ...params: [value: unknown, ttl?: number]) {
            return cache.set(`auth_${key}`, ...params);
          },
          async delete(key: string) {
            await cache.del(`auth_${key}`);
          },
        }
      : undefined,
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
