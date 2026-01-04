import { DatabaseModule, DatabaseService } from '@bge/database';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import { authFactory } from './auth-factory';
import { StrategyController } from './strategy.controller';
import { StrategyService } from './strategy.service';

@Module({
  imports: [
    DatabaseModule,
    BetterAuthModule.forRootAsync({
      useFactory: (databaseClient: DatabaseService, configService: ConfigService) => {
        const auth = authFactory(databaseClient, configService);
        return { auth };
      },
      imports: [DatabaseModule, ConfigModule],
      inject: [DatabaseService, ConfigService],
    }),
  ],
  controllers: [StrategyController],
  providers: [StrategyService],
  exports: [StrategyService],
})
export class AuthModule {}
