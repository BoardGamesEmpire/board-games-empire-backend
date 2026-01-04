import type { PrismaClient } from '@bge/database';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { betterAuth, BetterAuthPlugin } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin, genericOAuth, username } from 'better-auth/plugins';
import process from 'node:process';

export function authFactory(client: PrismaClient, configService?: ConfigService) {
  Logger.log(`Initializing BetterAuth with ConfigService: ${configService instanceof ConfigService}`, 'authFactory');

  const options = buildOptions(configService);

  const port = configService?.get<number>('server.port') || parseInt(process.env.PORT || '33333', 10);
  const trustedOrigins = options.trusted.map((origin) => origin.replace(/{PORT}\/?$/i, port.toString()));

  const plugins: BetterAuthPlugin[] = [admin()];
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
    plugins.push(username());
  }

  return betterAuth({
    basePath: '/api/auth',
    baseURL: `${options.hostUrl}/api/auth`,
    hooks: {},
    url: options.hostUrl,
    secret: options.secret,
    database: prismaAdapter(client, {
      usePlural: true,
      transaction: true,
      provider: 'postgresql',
    }),
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
