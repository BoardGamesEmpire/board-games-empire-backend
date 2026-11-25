import 'reflect-metadata';
// OpenTelemetry SDK MUST be initialized before any module that should be
// auto-instrumented is imported. Keep this block at the very top of main.ts.
import { env } from '@bge/env';
import { registerShutdownHandlers } from '@bge/otel';
import { bootstrapLogger, otel } from './app/lib/logger';

// Imports below this line are instrumented by the OTel auto-instrumentations.
import { AuditContextService } from '@bge/actor-context';
import {
  AUTH_INSTANCE,
  AUTH_REQUEST_HANDLER,
  createAuthNodeHandler,
  fallbackLocaleRenderer,
  MAX_AUTH_REQUEST_BODY_BYTES,
} from '@bge/auth';
import { createPrismaCliMigrator, runBootstrap } from '@bge/bootstrap';
import { markOperationalRequest } from '@bge/health';
import type { I18nTranslations } from '@bge/i18n';
import { nestLoggerFromPino } from '@bge/logger';
import { permissionGraphFlushPatterns } from '@bge/permissions';
import { createWebClient } from '@bge/web-client';
import { Logger, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import { I18nService } from 'nestjs-i18n';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { RedisIoAdapter } from './app/adapters/redis-io.adapter';
import { AppModule } from './app/app.module';
import redisConfig, { redisConfigValidationSchema } from './app/configuration/redis.config';
import type { SwaggerConfig } from './app/configuration/swagger.config';
import { API_REQUEST_TIMEOUT_MS, installRequestBodyRateGuard } from './app/http/request-body-rate-guard';
import { setupApiDocument } from './app/lib/api-document';
import { createAuthClientIpHandler } from './app/lib/auth-client-ip';
import { createHostCheck } from './app/lib/host-check';
import type { ServerNames } from './app/lib/host-rule';
import { allowsEveryHost, createHostRule } from './app/lib/host-rule';
import { createOperationalGate, OPERATIONAL_PATHS } from './app/lib/operational-gate';
import { createSourceRule } from './app/lib/operational-sources';
import { PATHS_WITHOUT_QUERY } from './app/lib/paths-without-query';
import { RouteValidationPipe } from './app/lib/route-validation.pipe';
import { createSecurityHeaders } from './app/lib/security-headers';

// The paths name feature-lib routes, imported above, so they reach the SDK
// only now; no request is served before the app listens (#935).
otel.withholdQueryFor(PATHS_WITHOUT_QUERY);

async function bootstrap() {
  const LOGGER_CONTEXT = 'Bootstrap';
  if (!env.isProduction) {
    Error.stackTraceLimit = Infinity;
  }

  bootstrapLogger.debug(`Bootstrapping BoardgamesEmpire api in ${env.currentEnv} mode`);

  // Migrations, catalog reconcile and seeds run BEFORE the application module
  // exists: several of its `onModuleInit` hooks read tables, so on a fresh
  // database they would fail ahead of any hook that could migrate (#236).
  // The api is the one build that carries the migrator; what happens is decided
  // from the database's state, not from a flag.
  await runBootstrap({
    applicationName: 'api',
    logger: nestLoggerFromPino(bootstrapLogger),
    migrator: createPrismaCliMigrator,
    // The same Redis the CacheModule below opens, so a catalog reconcile that
    // wrote rows flushes the cached ability graphs before the first request.
    cache: {
      redis: { config: redisConfig, validationSchema: redisConfigValidationSchema },
      flushPatterns: permissionGraphFlushPatterns(),
    },
  });

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    // Buffer module-init logs until `useLogger` is called below, so they
    // flow through nestjs-pino (and therefore through the OTel pipeline)
    // rather than going to stdout via Nest's default ConsoleLogger.
    bufferLogs: true,
    logger: nestLoggerFromPino(bootstrapLogger),
  });

  app.useLogger(app.get(PinoLogger));

  const globalPrefix = 'api';
  // The routes that sit outside the global prefix. The bundled web client
  // never answers under these or under the prefix itself, so it can't answer
  // the operational routes on the public port either (#1511).
  const unprefixedRoutes = [
    ...OPERATIONAL_PATHS,
    { path: 'health/*path', method: RequestMethod.GET },
    { path: '.well-known/*path', method: RequestMethod.GET },
    { path: '.well-known/*path', method: RequestMethod.OPTIONS },
  ];
  const configService = app.get(ConfigService);

  app.enable('trust proxy').set('etag', 'strong').set('x-powered-by', false);

  // `trust proxy` shapes `req.protocol` and `req.secure`, which better-auth and
  // the cookie flags read. It deliberately does NOT shape rate limiting any
  // more: the IP tier carries its own tracker, because Express resolves `req.ip`
  // from the leftmost `X-Forwarded-For` entry, which the client writes (#340).
  //
  // The two can disagree — `trust proxy` on while THROTTLE_TRUSTED_PROXY_HOPS is
  // 0 — and that disagreement is quiet in the direction that hurts. It is not
  // warned about here: at boot the only thing knowable is the setting, and a
  // warning on the documented default fires on every local run. `createIpTracker`
  // warns once on the first request that actually carries a forwarded header,
  // which is the first moment there is evidence rather than a guess.

  // Refuses a request for any name that isn't this server's, so a page that
  // rebinds its own domain to this address can't read what the api answers
  // without a session (#977).
  const serverNames: ServerNames = {
    publicUrl: configService.getOrThrow<string>('auth.url'),
    trustedOrigins: configService.getOrThrow<string[]>('auth.trustedOrigins'),
    mediaBaseUrl: configService.getOrThrow<string>('media.baseUrl'),
  };
  // Refusals ahead of Nest's i18n render in the fallback locale: the Host
  // check's here, and `/api/auth/*`'s below.
  const render = fallbackLocaleRenderer(app.get<I18nService<I18nTranslations>>(I18nService));
  const hostCheck = createHostCheck({ rule: createHostRule(serverNames), render });
  const operationalGate = createOperationalGate({
    sourceRule: createSourceRule(configService.getOrThrow<string[]>('operational.sources')),
    render,
  });

  if (allowsEveryHost(serverNames)) {
    Logger.warn(
      'TRUSTED_ORIGINS has an entry that matches every name, so this server answers at any address and DNS rebinding can reach it',
      LOGGER_CONTEXT,
    );
  }

  app
    // I18nValidationPipe is ValidationPipe with an i18n-aware exceptionFactory:
    // decorator messages tagged via `i18nValidationMessage` (see @bge/i18n) are
    // resolved against the request locale by the I18nValidationExceptionFilter
    // (app.module). Options are unchanged from the plain ValidationPipe; #142.
    // RouteValidationPipe applies it to routes only: a gateway's frames keep
    // their handlers' own pipes (#180).
    .useGlobalPipes(
      new RouteValidationPipe(app.get(AuditContextService), {
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true,
        validationError: {
          target: false,
          value: false,
        },
        transformOptions: {
          enableImplicitConversion: true,
        },
      }),
    )
    // helmet's headers, without the https upgrade on the operational port, which
    // is plain HTTP (#1511).
    .use(createSecurityHeaders())
    // Ahead of the web client and the better-auth mount below, so it covers the
    // whole Express app. It reads the Host header and not `req.hostname`, which
    // `trust proxy` above takes from X-Forwarded-Host (#977).
    .use(hostCheck.handler)
    // Keeps each listener to its own routes, and the operational port to the
    // addresses allowed to reach it (#1511). Mounted without a path, so it reads
    // the whole request target, and after the Host check, which stays the first
    // answer on both listeners.
    .use(operationalGate)
    .use(compression())
    .setGlobalPrefix(globalPrefix, { exclude: unprefixedRoutes })
    .enableCors({
      origin: [env.provide('BETTER_AUTH_URL', { defaultValue: '*' }), '*'],
      credentials: true,
      methods: ['GET', 'PATCH', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    });

  // The web client, when the image carries its build beside this bundle
  // (#598). It runs before Nest's routes are registered, which is why it is
  // told which paths are the server's rather than relying on route order.
  // Socket.IO answers `/socket.io/` itself but passes on `/socket.io` without
  // the slash, so its path is listed too.
  const webClientRoot = join(__dirname, 'web');
  const webClient = await createWebClient({
    root: webClientRoot,
    serverRoutes: [globalPrefix, 'socket.io', ...unprefixedRoutes.map(({ path }) => path)],
  });
  if (webClient) {
    app.use(webClient);
    Logger.log(`Serving the web client from ${webClientRoot}`, LOGGER_CONTEXT);
  } else {
    Logger.log(`No web client in ${webClientRoot}; serving the API only`, LOGGER_CONTEXT);
  }

  // NOTE: `enableShutdownHooks()` is intentionally omitted. The manual
  // signal handlers registered below sequence `app.close()` BEFORE
  // `otel.shutdown()` so the trailing batch of spans is exported.
  // `app.close()` still invokes all `OnApplicationShutdown` providers.

  const authInstance = app.get(AUTH_INSTANCE);

  // The API document, on the operational port only: the gate refuses it on the
  // public port. It is built on the first request for it, not at boot (#1511).
  setupApiDocument(app, {
    config: configService.getOrThrow<SwaggerConfig>('swagger'),
    globalPrefix,
    loadAuthSchema: () => authInstance.api.generateOpenAPISchema(),
  });

  const redisAdapter = new RedisIoAdapter(hostCheck.allowRequest, app);
  await redisAdapter.connectToRedis(configService);

  app.useWebSocketAdapter(redisAdapter);

  const server = app.getHttpAdapter().getInstance();
  // better-auth reads a client's IP only from the header the first handler
  // writes, by the same rule and configuration as the Nest throttler. Its
  // handler is served with a code on the answers it gives without one (#640),
  // and no body is read past MAX_AUTH_REQUEST_BODY_BYTES (#1057).
  //
  // @thallesp/nestjs-better-auth mounts a second handler on /api/auth, with
  // no limit. Every routed path reaches this one first, and it never calls
  // `next`. Only unrouted paths such as /api/auth/ fall through, and
  // better-auth answers those 404 before it reads a body.
  server.all(
    `/${globalPrefix}/auth/*any`,
    createAuthClientIpHandler(configService.getOrThrow<number>('throttle.trustedProxyHops')),
    createAuthNodeHandler(app.get(AUTH_REQUEST_HANDLER), { maxBodyBytes: MAX_AUTH_REQUEST_BODY_BYTES, render }),
  );

  // A plugin artifact upload may be 100 MiB from a slow connection, so a request
  // may take up to an hour, which a 100 MiB body meets at an average of about
  // 29 KB/s. Within that hour, the rate guard cuts off a body that stops
  // arriving much sooner: at least 64 KiB must arrive in every 60 seconds, on
  // every route including `/api/auth` (#1094). `headersTimeout` keeps Node's
  // default of 60 seconds, which is below `requestTimeout` as Node requires.
  const httpServer = app.getHttpServer();
  httpServer.requestTimeout = API_REQUEST_TIMEOUT_MS;
  installRequestBodyRateGuard(httpServer);

  // The second listener, for `/health`, `/metrics` and the API document
  // (#1511). It hands each request to the same Express app, marked, so the
  // gate and the health controller can tell which port it came in on.
  // Socket.IO stays on the public server alone.
  //
  // Nothing is uploaded here, so it keeps Node's request timeout (5 minutes)
  // rather than the public server's hour, and Node's 60-second
  // `headersTimeout`. The rate guard still cuts off a trickled body.
  const operationalServer = createServer((req, res) => {
    markOperationalRequest(req);
    server(req, res);
  });
  installRequestBodyRateGuard(operationalServer);

  // The operational listener stops taking connections as the app starts to
  // close, and Node closes its idle keep-alive connections, such as a
  // scraper's. A request still running there is not waited for past
  // `app.close()`: a first API document request held by a sign-in provider
  // that never answers, or a health check of an outside service, could
  // otherwise hold up the app's destroy hooks and the last spans (#1511).
  registerShutdownHandlers(
    {
      close: async () => {
        const operationalClosed = closeServer(operationalServer).catch((error: unknown) =>
          bootstrapLogger.error({ err: error }, 'closing the operational port failed'),
        );
        try {
          await app.close();
        } finally {
          operationalServer.closeAllConnections();
          await operationalClosed;
        }
      },
    },
    otel,
    bootstrapLogger,
  );

  // `app.init()` registers Nest's routes, which both listeners serve. The
  // operational port is bound before the public one, so a bind failure
  // (EADDRINUSE) exits through the catch below before the public port's
  // readiness ever answers (#1511). Bound on every interface, as the public
  // port is: the allowed sources decide who may use it.
  await app.init();

  const operationalPort = configService.getOrThrow<number>('operational.port');
  await listen(operationalServer, operationalPort);
  Logger.log(`Operational routes on port ${operationalPort}`, LOGGER_CONTEXT);

  const port = configService.getOrThrow<number>('system.port');
  await app.listen(port);
  Logger.log(`🚀 Application is running on: http://localhost:${port}/${globalPrefix}`, LOGGER_CONTEXT);
}

/** `server.listen`, resolved once it is listening and rejected with a bind error. */
function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** `server.close`, resolved at once for a server that never started listening. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => (error ? reject(error) : resolve()));
  });
}

bootstrap().catch((error) => {
  bootstrapLogger.error({ err: error }, 'bootstrap failed');
  void otel.shutdown().finally(() => process.exit(1));
});
