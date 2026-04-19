import { AUTH_INSTANCE } from '@bge/auth';
import { env } from '@bge/env';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { toNodeHandler } from 'better-auth/node';
import compression from 'compression';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';
import { RedisIoAdapter } from './app/adapters/redis-io.adapter';
import { AppModule } from './app/app.module';

async function bootstrap() {
  if (!env.isProduction) {
    Error.stackTraceLimit = Infinity;
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  if (env.provide('USE_PINO_LOGGER') === 'true') {
    app.useLogger(app.get(PinoLogger));
  }

  const globalPrefix = 'api';
  const configService = app.get(ConfigService);

  app.enable('trust proxy').set('etag', 'strong').set('x-powered-by', false);

  app
    .useGlobalPipes(
      new ValidationPipe({
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
    .setGlobalPrefix(globalPrefix, {
      exclude: [
        {
          path: 'metrics',
          method: RequestMethod.GET,
        },
        {
          path: 'health',
          method: RequestMethod.GET,
        },
      ],
    })
    .enableShutdownHooks()
    .enableCors({
      origin: [env.provide('BETTER_AUTH_URL', { defaultValue: '*' }), '*'],
      credentials: true,
      methods: ['GET', 'PATCH', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    });

  const authInstance = app.get(AUTH_INSTANCE);
  const swagger = configService.get<boolean>('swagger.enabled');

  Logger.debug(`Swagger enabled: ${swagger}`);

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
  }

  const redisAdapter = new RedisIoAdapter(app);
  await redisAdapter.connectToRedis(configService);

  app.useWebSocketAdapter(redisAdapter);

  const server = app.getHttpAdapter().getInstance();
  server.all(`/${globalPrefix}/auth/*any`, toNodeHandler(authInstance));

  const port = configService.get<number>('server.port', 33333);
  await app.listen(port);
  Logger.log(`🚀 Application is running on: http://localhost:${port}/${globalPrefix}`);
}

bootstrap();
