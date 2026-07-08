import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { GameImportController } from './game-import.controller';
import { GameImportStatusService } from './services/import-status.service';

/**
 * API-side module for the game-import domain. Owns the HTTP controller
 * that translates REST requests into coordinator RPC calls, plus the
 * status read side that resolves a batchId against the Job table.
 */
@Module({
  imports: [DatabaseModule, GatewayCoordinatorClientModule],
  controllers: [GameImportController],
  providers: [GameImportStatusService],
})
export class GameImportProducerModule {}
