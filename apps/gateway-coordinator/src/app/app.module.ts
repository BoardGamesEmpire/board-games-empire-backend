import { DatabaseModule } from '@bge/database';
import { env } from '@bge/env';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configuration, configurationValidationSchema } from './configuration';
import { CoordinatorModule } from './coordinator/coordinator.module';
import { GatewayRegistryModule } from './gateway-registry/gateway-registry.module';

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
    DatabaseModule,
    CoordinatorModule,
    GatewayRegistryModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
