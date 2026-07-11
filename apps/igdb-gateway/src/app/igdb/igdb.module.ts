import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import igdb from 'igdb-api-node';
import { configuration } from './configuration';
import { IGDB_CLIENT_FACTORY } from './constants';
import { IgdbAuthService } from './igdb-auth.service';
import type { IgdbClientFactory } from './igdb.service';
import { IGDBService } from './igdb.service';

@Global()
@Module({
  imports: [ConfigModule.forFeature(configuration.igdb)],
  providers: [
    {
      // Provides a factory rather than a single client: the apicalypse builder
      // is stateful, so every request must construct its own client instance.
      // The IGDBService owns the access-token lifecycle and passes the current
      // token in per call.
      provide: IGDB_CLIENT_FACTORY,
      useFactory: (configService: ConfigService): IgdbClientFactory => {
        const clientId = configService.getOrThrow<string>('igdb.clientId');

        return (accessToken: string) => igdb(clientId, accessToken);
      },
      inject: [ConfigService],
    },
    IGDBService,
    IgdbAuthService,
  ],
  exports: [IGDBService],
})
export class IgdbModule {}
