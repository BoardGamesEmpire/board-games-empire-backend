import 'reflect-metadata';
// OpenTelemetry SDK MUST be initialized before any module that should be
// auto-instrumented is imported. Keep this block at the very top of main.ts.
import { env } from '@bge/env';
import { registerShutdownHandlers } from '@bge/otel';
import { bootstrapLogger, otel } from './app/lib/logger';

// Imports below this line are instrumented by the OTel auto-instrumentations.
import { AUTH_INSTANCE } from '@bge/auth';
import { createPrismaCliMigrator, nestLoggerFromPino, runBootstrap } from '@bge/bootstrap';
import { createWebClient } from '@bge/web-client';
import { Logger, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { toNodeHandler } from 'better-auth/node';
import compression from 'compression';
import helmet from 'helmet';
import { I18nValidationPipe } from 'nestjs-i18n';
import { Logger as PinoLogger } from 'nestjs-pino';
import { join } from 'node:path';
import { RedisIoAdapter } from './app/adapters/redis-io.adapter';
import { AppModule } from './app/app.module';
import { bootstrapCacheFlushPatterns } from './app/configuration/cache-flush';
import redisConfig, { redisConfigValidationSchema } from './app/configuration/redis.config';

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
      flushPatterns: bootstrapCacheFlushPatterns(),
    },
  });

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    // Buffer module-init logs until `useLogger` is called below, so they
    // flow through nestjs-pino (and therefore through the OTel pipeline)
    // rather than going to stdout via Nest's default ConsoleLogger.
    bufferLogs: true,
  });

  app.useLogger(app.get(PinoLogger));

  const globalPrefix = 'api';
  // The routes that sit outside the global prefix. The bundled web client
  // never answers under these or under the prefix itself.
  const unprefixedRoutes = [
    { path: 'metrics', method: RequestMethod.GET },
    { path: 'health', method: RequestMethod.GET },
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

  app
    // I18nValidationPipe is ValidationPipe with an i18n-aware exceptionFactory:
    // decorator messages tagged via `i18nValidationMessage` (see @bge/i18n) are
    // resolved against the request locale by the I18nValidationExceptionFilter
    // (app.module). Options are unchanged from the plain ValidationPipe; #142.
    .useGlobalPipes(
      new I18nValidationPipe({
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
    .use(helmet())
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
  const webClientRoot = join(__dirname, 'web');
  const webClient = await createWebClient({
    root: webClientRoot,
    serverRoutes: [globalPrefix, ...unprefixedRoutes.map(({ path }) => path)],
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
  const swagger = configService.get<boolean>('swagger.enabled');

  Logger.debug(`Swagger enabled: ${swagger}`, LOGGER_CONTEXT);

  if (swagger) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle(configService.getOrThrow('swagger.title'))
      .setDescription(configService.getOrThrow('swagger.description'))
      .setVersion(configService.getOrThrow('swagger.version'))
      .addBearerAuth()
      .addApiKey({
        type: 'apiKey',
        name: 'x-access-token',
        in: 'header',
      })
      .build();

    const openAPISchema: OpenAPIObject = await authInstance.api.generateOpenAPISchema();
    const paths = Object.entries(openAPISchema.paths).reduce(
      (acc, [path, methods]) => ({
        ...acc,
        [path.startsWith(`/${globalPrefix}/auth`) ? path : `/${globalPrefix}/auth${path}`]: methods,
      }),
      {} as OpenAPIObject['paths'],
    );

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    const merged = {
      ...document,
      paths: { ...document.paths, ...paths },
      components: {
        ...document.components,
        schemas: { ...document.components?.schemas, ...openAPISchema.components?.schemas },
      },
    };
    SwaggerModule.setup(globalPrefix, app, merged, {
      jsonDocumentUrl: `${globalPrefix}/swagger/json`,
      yamlDocumentUrl: `${globalPrefix}/swagger/yaml`,
    });

    Logger.debug('Swagger document created and setup completed', LOGGER_CONTEXT);
  }

  const redisAdapter = new RedisIoAdapter(app);
  await redisAdapter.connectToRedis(configService);

  app.useWebSocketAdapter(redisAdapter);

  const server = app.getHttpAdapter().getInstance();
  server.all(`/${globalPrefix}/auth/*any`, toNodeHandler(authInstance));

  registerShutdownHandlers(app, otel, bootstrapLogger);

  const port = configService.get<number>('system.port', 33333);
  await app.listen(port);
  Logger.log(`🚀 Application is running on: http://localhost:${port}/${globalPrefix}`, LOGGER_CONTEXT);
}

bootstrap().catch((error) => {
  bootstrapLogger.error({ err: error }, 'bootstrap failed');
  void otel.shutdown().finally(() => process.exit(1));
});
