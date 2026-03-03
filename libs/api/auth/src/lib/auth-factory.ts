import { passkey } from '@better-auth/passkey';
import type { PrismaClient, User } from '@bge/database';
import { Cache } from '@nestjs/cache-manager';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { betterAuth, BetterAuthPlugin } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import {
  admin,
  anonymous,
  deviceAuthorization,
  genericOAuth,
  lastLoginMethod,
  oneTap,
  oneTimeToken,
  openAPI,
  twoFactor,
} from 'better-auth/plugins';
import process from 'node:process';
import { UserProvisioningService } from './provisioning/user-provisioning.service';

export function authFactory(
  prisma: PrismaClient,
  configService?: ConfigService,
  cache?: Cache,
  userProvisioningService?: UserProvisioningService,
) {
  const logger = new Logger('AuthFactory');
  logger.log(`Initializing BetterAuth with ConfigService: ${configService instanceof ConfigService}`);

  const options = buildOptions(configService);

  const port = configService?.get<number>('server.port') || parseInt(process.env.PORT || '33333', 10);
  const trustedOrigins = options.trusted.map((origin) => origin.replace(/{PORT}\/?$/i, port.toString()));

  logger.log(`Trusted origins set to: ${trustedOrigins.join(', ')}`);

  // TODO: Make plugins configurable
  const plugins: BetterAuthPlugin[] = [
    admin(),
    anonymous(),
    lastLoginMethod(),
    oneTap(),
    oneTimeToken(),
    passkey(),
    twoFactor(),

    deviceAuthorization({
      verificationUri: '/device',
    }),
  ];

  if (configService?.get<boolean>('swagger.enabled')) {
    logger.log('Enabling OpenAPI plugin for API documentation');
    plugins.push(openAPI());
  }

  if (hasOIDC(configService)) {
    const oidcConfig = buildOIDC(configService);
    logger.log(`Enabling OIDC provider: ${oidcConfig.providerId}`);

    plugins.push(
      genericOAuth({
        config: [
          {
            providerId: oidcConfig.providerId,
            discoveryUrl: oidcConfig.wellKnownUrl,
            clientId: oidcConfig.clientId,
            clientSecret: oidcConfig.clientSecret,
          },
        ],
      }),
    );
  }

  if (options.useEmailPass) {
    logger.log('Enabling Email & Password authentication');
  }

  return betterAuth({
    telemetry: { enabled: false },
    advanced: {
      cookiePrefix: 'bge_auth_',
      disableOriginCheck: options.disableOriginCheck,
    },
    basePath: '/api/auth',
    appName: 'BoardGamesEmpire',
    baseURL: `${options.hostUrl}/api/auth`,
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
      debugLogs: configService?.get<boolean>('server.is_production') === false,
      transaction: false,
      provider: 'postgresql',
    }),
    databaseHooks: {
      user: {
        create: {
          async after(user: any) {
            if (!userProvisioningService) {
              throw new Error('UserProvisioningService not provided to authFactory');
            }

            await userProvisioningService.provisionNewUser(user as User);
          },
        },
      },
    },
    secondaryStorage: cache
      ? {
          get(key: string) {
            return cache.get(`auth_${key}`);
          },
          set(key: string, ...params: [value: any, ttl?: number]) {
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
  const envUrl = process.env.BETTER_AUTH_URL;
  const envSecret = process.env.BETTER_AUTH_SECRET;
  const envOrigins = process.env.TRUSTED_ORIGINS?.split(',') || [];
  const envEmailPass = process.env.USE_EMAIL_PASSWORD_AUTH === 'true';
  const disableOriginCheck = process.env.DISABLE_ORIGIN_CHECK === 'true';

  if (configService instanceof ConfigService) {
    const hostUrl = configService.getOrThrow<string>('auth.url');
    const secret = configService.getOrThrow<string>('auth.secret');
    const trusted = configService.getOrThrow<string[]>('auth.trustedOrigins');
    const useEmailPass = configService.getOrThrow<boolean>('auth.useEmailPasswordAuth');
    const disableOriginCheck = configService.get<boolean>('auth.disableOriginCheck');

    return { hostUrl, secret, trusted, useEmailPass, disableOriginCheck };
  }

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
    const wellKnownUrl = configService.getOrThrow<string>('auth.oidcWellKnownUrl');
    const clientId = configService.getOrThrow<string>('auth.oidcClientId');
    const clientSecret = configService.getOrThrow<string>('auth.oidcClientSecret');
    const providerId = configService.get<string>('auth.oidcProviderId') || defaultProviderId;

    return { wellKnownUrl, clientId, clientSecret, providerId };
  }

  const wellKnownUrl = process.env.OIDC_WELL_KNOWN_URL;
  const clientId = process.env.OIDC_CLIENT_ID || '';
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  const providerId = process.env.OIDC_PROVIDER_ID || defaultProviderId;

  return { wellKnownUrl, clientId, clientSecret, providerId };
}
