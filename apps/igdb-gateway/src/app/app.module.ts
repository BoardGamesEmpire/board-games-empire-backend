import { env } from '@bge/env';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configuration, configurationValidationSchema } from './configuration';
import { GameGatewayModule } from './game-gateway/game-gateway.module';
import { IgdbModule } from './igdb/igdb.module';

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
    GameGatewayModule,
    IgdbModule,
  ],
})
export class AppModule {}
