import { IgdbDriver } from '@bge/gateway-driver-igdb';
import { createDriverLogger, DATA_GATEWAY_DRIVER, DataGatewayController, nodeUpstreamFetch } from '@bge/gateway-host';
import { BGE_VERSION } from '@bge/version';
import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { configuration } from '../igdb/configuration';
import type { IGDBConfig } from '../igdb/configuration/igdb.config';

/**
 * Serves IGDB as a remote DataGateway: the shared gRPC controller over
 * IgdbDriver, which reaches IGDB and its token endpoint through Node's fetch
 * and reports the BGE version on Ping (#1082). The igdb config is loaded
 * here; the root schema validates it.
 */
@Module({
  imports: [ConfigModule.forFeature(configuration.igdb)],
  controllers: [DataGatewayController],
  providers: [
    {
      provide: DATA_GATEWAY_DRIVER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new IgdbDriver({
          ...config.getOrThrow<IGDBConfig>('igdb'),
          fetch: nodeUpstreamFetch,
          version: BGE_VERSION,
          logger: createDriverLogger(IgdbDriver.name),
        }),
    },
  ],
})
export class DataGatewayModule implements OnModuleInit {
  constructor(@Inject(DATA_GATEWAY_DRIVER) private readonly driver: IgdbDriver) {}

  /**
   * Fetches the first token while the app initializes, before it serves. A
   * token endpoint that refuses, or doesn't answer within 10 seconds, fails
   * the boot through the shared bootstrap, which logs `bootstrap failed` and
   * exits 1 (#630). A factory that threw would end the process from inside
   * Nest instead, without that record.
   */
  async onModuleInit(): Promise<void> {
    await this.driver.start();
  }
}
