import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BggClient } from 'bgg-ts-client';
import type { BoardGameGeekConfig } from '../configuration/boardgamegeek.config';
import { BggService } from './bgg.service';
import { BGG_CLIENT } from './constants';

/**
 * Provides a singleton, API-key-authenticated BoardGameGeek client and
 * the `BggService` wrapper that adds Observable + retry semantics on top.
 */
@Global()
@Module({
  providers: [
    {
      provide: BGG_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const bggConfig = configService.getOrThrow<BoardGameGeekConfig>('boardgamegeek');
        return BggClient.Create(bggConfig);
      },
    },
    BggService,
  ],
  exports: [BggService, BGG_CLIENT],
})
export class BggModule {}
