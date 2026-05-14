import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { Module } from '@nestjs/common';
import { GameImportController } from './game-import.controller';

/**
 * API-side module for the game-import domain. Owns the HTTP controller
 * that translates REST requests into coordinator RPC calls.
 */
@Module({
  imports: [GatewayCoordinatorClientModule],
  controllers: [GameImportController],
})
export class GameImportProducerModule {}
