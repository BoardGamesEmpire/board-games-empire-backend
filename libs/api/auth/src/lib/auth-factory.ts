import { passkey } from '@better-auth/passkey';
import type { PrismaClient } from '@bge/database';
import { Cache } from '@nestjs/cache-manager';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { betterAuth, BetterAuthPlugin } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import {
  admin,
  anonymous,
  apiKey,
  deviceAuthorization,
  genericOAuth,
  lastLoginMethod,
  oneTap,
  oneTimeToken,
  openAPI,
  twoFactor,
} from 'better-auth/plugins';
import process from 'node:process';

export function authFactory(client: PrismaClient, configService?: ConfigService, cache?: Cache) {
  Logger.log(`Initializing BetterAuth with ConfigService: ${configService instanceof ConfigService}`, 'authFactory');

  const options = buildOptions(configService);

  const port = configService?.get<number>('server.port') || parseInt(process.env.PORT || '33333', 10);
  const trustedOrigins = options.trusted.map((origin) => origin.replace(/{PORT}\/?$/i, port.toString()));

  // TODO: Make plugins configurable
  const plugins: BetterAuthPlugin[] = [
    admin(),
    anonymous(),
    apiKey(),
    lastLoginMethod(),
    oneTap(),
    oneTimeToken(),
    openAPI(),
    passkey(),
    twoFactor(),

    deviceAuthorization({
      verificationUri: '/device',
    }),
  ];

  if (hasOIDC(configService)) {
    const oidcConfig = buildOIDC(configService);
    Logger.log(`Enabling OIDC provider: ${oidcConfig.providerId}`, 'authFactory');

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
    Logger.log('Enabling Email & Password authentication', 'authFactory');
  }

  return betterAuth({
    telemetry: { enabled: false },
    advanced: {
      cookiePrefix: 'bge_auth_',
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
    database: prismaAdapter(client, {
      debugLogs: configService?.get<boolean>('server.is_production') === false || false,
      transaction: true,
      provider: 'postgresql',
    }),
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

  if (configService instanceof ConfigService) {
    const hostUrl = configService.getOrThrow<string>('auth.url');
    const secret = configService.getOrThrow<string>('auth.secret');
    const trusted = configService.getOrThrow<string[]>('auth.trustedOrigins');
    const useEmailPass = configService.getOrThrow<boolean>('auth.useEmailPasswordAuth');

    return { hostUrl, secret, trusted, useEmailPass };
  }

  return { hostUrl: envUrl, secret: envSecret, trusted: envOrigins, useEmailPass: envEmailPass };
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
