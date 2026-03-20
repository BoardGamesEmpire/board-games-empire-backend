import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import igdb from 'igdb-api-node';
import { configuration } from './configuration';
import { IGDB_CLIENT } from './constants';
import { IGDBService } from './igdb.service';
import { fetchAccessToken } from './lib/fetch-access-token';

@Global()
@Module({
  imports: [ConfigModule.forFeature(configuration.igdb)],
  providers: [
    {
      provide: IGDB_CLIENT,
      useFactory: async (configService: ConfigService) => {
        const clientId = configService.getOrThrow<string>('igdb.clientId');
        const clientSecret = configService.getOrThrow<string>('igdb.clientSecret');
        const accessToken = await fetchAccessToken({ client_id: clientId, client_secret: clientSecret });

        return igdb(clientId, accessToken.access_token);
      },
      inject: [ConfigService],
    },
    IGDBService,
  ],
  exports: [IGDBService, IGDB_CLIENT],
})
export class IgdbModule {}
