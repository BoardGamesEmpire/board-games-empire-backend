import { authFactory } from '@bge/auth';
import { DatabaseService } from '@bge/database';
import { env } from '@bge/env';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { toNodeHandler } from 'better-auth/node';
import compression from 'compression';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';
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

  if (configService.get<boolean>('swagger.enabled')) {
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

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(globalPrefix, app, document);
  }

  const dbService = app.get(DatabaseService);
  const server = app.getHttpAdapter().getInstance();
  server.all(`/${globalPrefix}/auth/*any`, toNodeHandler(authFactory(dbService, configService)));

  const port = configService.get<number>('port', 33333);
  await app.listen(port);
  Logger.log(`🚀 Application is running on: http://localhost:${port}/${globalPrefix}`);
}

bootstrap();
