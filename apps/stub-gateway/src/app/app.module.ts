import { env } from '@bge/env';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { configuration, configurationValidationSchema } from './configuration';
import { DataGatewayModule } from './data-gateway/data-gateway.module';
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

    // The real gateways' logger, installed the same way: through `pinoHttp`,
    // which on a gRPC-only microservice does nothing but supply the instance.
    LoggerModule.forRoot({
      pinoHttp: {
        logger: baseLogger,
      },
    }),

    DataGatewayModule,
  ],
})
export class AppModule {}
