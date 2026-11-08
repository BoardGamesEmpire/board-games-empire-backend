import { apiKey } from '@better-auth/api-key';
import { passkey } from '@better-auth/passkey';
import { prismaAdapter } from '@better-auth/prisma-adapter';
import type { AuditContextService, SystemActorScope } from '@bge/actor-context';
import type { PrismaClient } from '@bge/database';
import { isTrue, splitTrimFilter } from '@bge/env';
import type { I18nTranslations } from '@bge/i18n';
import type { MailDispatcherService } from '@bge/queue-mail';
import { Logger, type LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { betterAuth } from 'better-auth';
import { createAuthMiddleware, getOAuthState } from 'better-auth/api';
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
import { appSignIn } from './app-sign-in';
import type { CompleteAuthStorage } from './auth-storage';
import { betterAuthLogger } from './better-auth-logger';
import {
  idsAllowingUnverifiedEmail,
  type OidcProviderConfig,
  readOidcProviders,
  unlistedOidcVariables,
} from './configuration/oidc-providers';
import { AUTH_BASE_PATH, AUTH_CLIENT_IP_HEADER, AUTH_COOKIE_PREFIX, SESSION_FRESH_AGE_SECONDS } from './constants';
import { UserCreatedEvent } from './events/auth.events';
import { createIdTokenGate } from './id-token-gate';
import { mapOidcProfile, OIDC_SCOPES } from './oidc-profile';
import { createPasswordReset, passwordResetDeps } from './password-reset';
import { createProviderEmailGate } from './provider-email-gate';
import { createProviderLinkFreshness } from './provider-link-freshness';
import { createProviderLinkingGate, providerLinkingPolicyReader } from './provider-linking-gate';
import { providerPictureOnly } from './provider-picture';
import { createProviderUserInfo } from './provider-user-info';
import { createSettingGates, settingGateDeps } from './setting-gates';
import { createSignOutHook } from './sign-out-hook';
import { createUsernameVariants } from './username-variant';

interface UserCreatedHookDeps {
  eventEmitter?: EventEmitter2;
  auditContext?: AuditContextService;
  systemActorScope?: SystemActorScope;
  /**
   * The username a sign-in asked for when it was replaced by a variant (#912),
   * read with the endpoint context `user.create.before` saw.
   */
  requestedUsername?: (context: object | null) => string | null;
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
export function createUserCreatedHook(
  deps: UserCreatedHookDeps,
): (user: User, context?: object | null) => Promise<void> {
  const { eventEmitter, auditContext, systemActorScope, requestedUsername } = deps;

  return async (user: User, context?: object | null): Promise<void> => {
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
      requestedUsername?.(context ?? null) ?? null,
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
  storage?: CompleteAuthStorage,
  eventEmitter?: EventEmitter2,
  auditContext?: AuditContextService,
  systemActorScope?: SystemActorScope,
  i18n?: I18nService<I18nTranslations>,
  // Without one, as when the better-auth CLI builds the instance, there is no
  // outgoing mail: a reset request keeps better-auth's own refusal (#654).
  mailDispatcher?: Pick<MailDispatcherService, 'enqueue'>,
) {
  const logger = new Logger('AuthFactory');
  logger.log(`Initializing BetterAuth with ConfigService: ${configService instanceof ConfigService}`);

  const options = buildOptions(configService);

  const port = configService?.get<number>('system.port') || parseInt(process.env.PORT || '33333', 10);
  const trustedOrigins = options.trusted.map((origin) => origin.replace(/{PORT}\/?$/i, port.toString()));

  logger.log(`Trusted origins set to: ${trustedOrigins.join(', ')}`);

  const providers = oidcProvidersFor(configService);
  for (const provider of providers) {
    logger.log(`Enabling sign-in provider: ${provider.id}`);
  }

  // A variable for an id OIDC_PROVIDERS does not list is most often a typo in
  // the id, which would leave that provider silently off (#912).
  const providerIds = providers.map((provider) => provider.id);
  for (const key of unlistedOidcVariables(process.env, providerIds)) {
    logger.warn(`${key} names a sign-in provider that OIDC_PROVIDERS does not list`);
  }

  if (options.useEmailPass) {
    logger.log('Enabling Email & Password authentication');
  }

  const gateDeps = settingGateDeps(prisma, i18n);
  const settingGates = createSettingGates(gateDeps);
  const signOutHook = createSignOutHook({ render: gateDeps.render });
  const idTokenGate = createIdTokenGate(gateDeps.render);
  const providerLinkFreshness = createProviderLinkFreshness({ render: gateDeps.render });
  const usernameVariants = createUsernameVariants(prisma);
  const providerEmailGate = createProviderEmailGate(providers, gateDeps.render);
  const providerLinkingGate = createProviderLinkingGate({
    readPolicy: providerLinkingPolicyReader(prisma),
    readOAuthState: getOAuthState,
    render: gateDeps.render,
  });
  const passwordReset = mailDispatcher && createPasswordReset(passwordResetDeps(prisma, mailDispatcher, i18n));

  const usingSwagger = configService?.get<boolean>('swagger.enabled');
  if (usingSwagger) {
    logger.log('Enabling OpenAPI plugin for API documentation');
  }

  // TODO: Make plugins configurable
  const plugins = [
    // Native apps sign in through the redirect flow, on routes of their own
    // (#1019). First: its hook on the provider's callback takes the session
    // off the response before any other plugin's hook sees it. After it, the
    // anonymous plugin can't take the app's sign-in for a guest's upgrade and
    // delete the browser's guest, and the bearer and last-login-method
    // plugins find no session to hand a credential or a cookie.
    //
    // `iss` is the issuer discovery publishes, read from the same
    // configuration. It is missing only in the better-auth CLI's instance
    // (`utils/auth.ts`), which serves no requests; the api's comes from
    // `getOrThrow('auth.url')`, which also builds `baseURL`.
    appSignIn({ render: gateDeps.render, issuer: options.hostUrl ?? '' }),

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

    ...(providers.length > 0
      ? [genericOAuth({ config: providers.map((provider) => toGenericOAuthConfig(provider, logger)) })]
      : []),

    ...(usingSwagger ? [openAPI()] : []),

    deviceAuthorization({ verificationUri: '/device' }),
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
      // better-auth 1.7 moved this out of `experimental` (#1016).
      database: { joins: true },
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
      // Every link a sign-in makes itself passes the provider linking gate
      // (#913). better-auth runs it for each new user, each returning sign-in
      // through a provider and each link from a signed-in session as well, and
      // the gate lets those through.
      validateUserInfo: providerLinkingGate,
    },
    account: {
      // A provider sign-in may link itself to the registered user with the
      // same email, but only when the provider linking policy allows it: the
      // gate on `user.validateUserInfo` decides (#913). better-auth's own
      // conditions run first, among them that this server has verified the
      // registered user's email, and the gate sees only the links that pass
      // them. A link made from a signed-in session needs no policy, and may use
      // a different email because people often hold different addresses at
      // the provider and on this server (#912).
      //
      // A provider the operator allows unverified emails for is trusted for
      // linking (#1016): the session, not the email claim, grants a link made
      // from a signed-in session, and without this the provider could sign
      // in but never link. better-auth lets a trusted provider past its check
      // on the provider's email for a link a sign-in makes itself too, so the
      // gate checks that email itself.
      accountLinking: {
        disableImplicitLinking: false,
        // better-auth's own default, set here because the policy relies on
        // it: the gate sees only the provider's email claim, never whether
        // this server has verified the registered user's email (#913).
        requireLocalEmailVerified: true,
        allowDifferentEmails: true,
        trustedProviders: idsAllowingUnverifiedEmail(providers),
      },
    },
    session: {
      // One day, better-auth's own default, set here so every fresh-session
      // check agrees: better-auth's on its sensitive routes, and the one on
      // starting a link to a sign-in provider (#913).
      freshAge: SESSION_FRESH_AGE_SECONDS,
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        // Resets switched off is the answer whatever the mail settings, so the
        // gate runs before the mail checks.
        await settingGates.beforeRoute(context);
        await passwordReset?.beforeRoute(context);
        await signOutHook.beforeRoute(context);
        idTokenGate.beforeRoute(context);
        await providerLinkFreshness.beforeRoute(context);
      }),
    },
    secret: options.secret,
    database: prismaAdapter(prisma, {
      // Off everywhere (#627). The adapter prints these through a console
      // logger of its own, never the `logger` above, so they would bypass pino,
      // and they carry each query's inputs and results: addresses, session
      // tokens, password hashes. DATABASE_LOG_QUERIES shows the queries instead.
      debugLogs: false,
      transaction: false,
      provider: 'postgresql',
    }),
    databaseHooks: {
      user: {
        create: {
          // The gates first: a refused sign-up writes nothing, so there is
          // no username to vary and no picture to keep or drop. Registration
          // before the provider's email, since a closed server is the answer
          // whatever the email.
          before: async (user, context) => {
            await settingGates.beforeUserCreate(user, context);
            providerEmailGate(user, context);

            const variant = await usernameVariants.beforeUserCreate(user, context);
            const picture = providerPictureOnly(user, context);

            // better-auth merges `data` into the row; the two touch different fields.
            return variant || picture ? { data: { ...variant?.data, ...picture?.data } } : undefined;
          },
          after: createUserCreatedHook({
            eventEmitter,
            auditContext,
            systemActorScope,
            requestedUsername: usernameVariants.requestedUsername,
          }),
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
      // A reset token lives as long as the mail settings say (#654). The
      // prefix match needs plain identifiers, so `verification.storeIdentifier`
      // stays unset.
      ...(passwordReset && {
        verification: { create: { before: passwordReset.beforeVerificationCreate } },
      }),
    },
    // Without a storage, as when the better-auth CLI builds the instance,
    // better-auth keeps sessions in the database.
    secondaryStorage: storage,
    emailAndPassword: {
      enabled: options.useEmailPass,
      // `resetPasswordTokenExpiresIn` stays unset: if the verification hook
      // misses, better-auth's 1 hour applies, the shorter time (#654).
      ...(passwordReset && {
        sendResetPassword: passwordReset.sendResetPassword,
        revokeSessionsOnPasswordReset: true,
      }),
    },
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

/**
 * The sign-in providers to enable (#912). Without a `ConfigService`, as when
 * the better-auth command-line tool builds the instance, the same parser reads
 * the environment.
 */
function oidcProvidersFor(configService?: ConfigService): readonly OidcProviderConfig[] {
  if (configService instanceof ConfigService) {
    return configService.get<readonly OidcProviderConfig[]>('auth.oidcProviders') ?? [];
  }

  return readOidcProviders();
}

function toGenericOAuthConfig(provider: OidcProviderConfig, logger: Pick<LoggerService, 'warn'>) {
  return {
    providerId: provider.id,
    discoveryUrl: provider.discoveryUrl,
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    scopes: [...OIDC_SCOPES],
    mapProfileToUser: mapOidcProfile,
    // The ID token's claims merged with the provider's UserInfo answer; why
    // is on createProviderUserInfo (#993). One per provider: each keeps the
    // UserInfo endpoint its own discovery document lists.
    getUserInfo: createProviderUserInfo(provider, { logger }),
    // Every provider here is an OpenID Connect one, so `sub` is the user's
    // identity there. better-auth's default reads an `id` claim instead when
    // discovery omits `id_token_signing_alg_values_supported`, which refuses
    // every sign-in through such a provider (#1016). There is no fallback to
    // `id`, which could change which user a sign-in resolves to: a profile
    // without `sub` is refused, as better-auth refuses a blank key.
    accountSubject: ({ profile }: { profile: { sub?: string | number | null } }) => profile.sub ?? '',
    // Sign-out stays with this server until #1018 decides whether it may send
    // a user to the provider (#1016). Discovery's `end_session_endpoint`
    // would otherwise give the route a provider URL to answer with. Today the
    // sign-out hook deletes the session before the route runs, so the route
    // finds none and answers without one; this makes that deliberate, and it
    // holds if the hook changes.
    disableProviderLogout: true,
  };
}
