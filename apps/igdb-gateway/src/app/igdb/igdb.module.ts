import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import igdb from 'igdb-api-node';
import { configuration } from './configuration';
import { IGDB_CLIENT } from './constants';
import { IgdbAuthService } from './igdb-auth.service';
import { IGDBService } from './igdb.service';

@Global()
@Module({
  imports: [ConfigModule.forFeature(configuration.igdb)],
  providers: [
    {
      provide: IGDB_CLIENT,
      useFactory: async (configService: ConfigService, authService: IgdbAuthService) => {
        const clientId = configService.getOrThrow<string>('igdb.clientId');
        const clientSecret = configService.getOrThrow<string>('igdb.clientSecret');
        const accessToken = await authService.fetchAccessToken({ client_id: clientId, client_secret: clientSecret });

        return igdb(clientId, accessToken.access_token);
      },
      inject: [ConfigService, IgdbAuthService],
    },
    IGDBService,
    IgdbAuthService,
  ],
  exports: [IGDBService, IGDB_CLIENT],
})
export class IgdbModule {}
