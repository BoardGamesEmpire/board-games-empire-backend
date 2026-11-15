import { DatabaseService } from '@bge/database';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { GatewayRegistryService } from './gateway-registry.service';
import { remoteConnectionOptions } from './utils/remote-connection-options';

/**
 * Eagerly connects to all enabled remote DataGateways once the application
 * is fully bootstrapped. Uses OnApplicationBootstrap (not OnModuleInit) so
 * that Test.createTestingModule().compile() does NOT trigger gateway
 * connection attempts — only real app starts via app.init() / app.listen() do.
 *
 * Connecting a DataGateway never interviewed runs its first interview. One
 * that fails it isn't routed, and is connected and interviewed again when
 * next reached.
 *
 * A plugin DataGateway is left out: the gateway registry builds its driver
 * on first use, once the plugin loader has run (#1083).
 */
@Injectable()
export class GatewayRegistryBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(GatewayRegistryBootstrapService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: GatewayRegistryService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const gateways = await this.db.dataGateway.findMany({
      where: { enabled: true, deletedAt: null, pluginId: null },
    });

    this.logger.log(`Seeding gateway registry with ${gateways.length} enabled remote DataGateway(s)`);

    for (const gateway of gateways) {
      // Every row read is a remote DataGateway's, and the table's CHECK gives
      // each its connection fields. One without them is said, not skipped in
      // silence: the lazy connect throws for the same row.
      const options = remoteConnectionOptions(gateway);
      if (!options) {
        this.logger.error(
          `DataGateway '${gateway.name}' (${gateway.id}) has no connection fields; not connected during bootstrap`,
        );
        continue;
      }

      try {
        await this.registry.connect(options);

        this.logger.log(`Successfully connected gateway '${gateway.name}' (${gateway.id}) during bootstrap`);
      } catch (error) {
        this.logger.error(
          `Failed to connect gateway '${gateway.name}' (${gateway.id}) during bootstrap`,
          error instanceof Error ? error.stack : error,
        );
      }
    }

    this.logger.log(`Registry seeded. Connected: [${this.registry.connectedGatewayIds().join(', ')}]`);
  }
}
