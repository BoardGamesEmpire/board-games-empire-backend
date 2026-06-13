import { env } from '@bge/env';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { configuration, configurationValidationSchema } from './configuration';
import { GameGatewayModule } from './game-gateway/game-gateway.module';
import { baseLogger } from './lib/logger';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [...Object.values(configuration)],
      cache: true,
      isGlobal: true,
      expandVariables: true,
      validationSchema: configurationValidationSchema,
      validationOptions: {
        abortEarly: true,
        cache: !env.isProduction,
        debug: !env.isProduction,
        stack: !env.isProduction,
      },
    }),

    // Structured logging via pino, matching the configuration used by
    // every OTel-enabled service. `pinoHttp` is the only injection
    // point nestjs-pino exposes for supplying an existing pino
    // instance; on a pure gRPC microservice it is benign (no request
    // lifecycle, no HTTP middleware fires) but installs the logger
    // for `app.useLogger(app.get(PinoLogger))` consumption.
    LoggerModule.forRoot({
      pinoHttp: {
        logger: baseLogger,
      },
    }),

    GameGatewayModule,
  ],
})
export class AppModule {}
