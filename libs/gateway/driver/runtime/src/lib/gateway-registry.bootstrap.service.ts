import { DatabaseService } from '@bge/database';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { GatewayRegistryService } from './gateway-registry.service';
import { remoteConnectionOptions } from './utils/remote-connection-options';

/**
 * Eagerly connects to all enabled gateways once the application is fully
 * bootstrapped. Uses OnApplicationBootstrap (not OnModuleInit) so that
 * Test.createTestingModule().compile() does NOT trigger gateway connection
 * attempts — only real app starts via app.init() / app.listen() do.
 *
 * Connecting a DataGateway never interviewed runs its first interview. One
 * that fails it isn't routed, and is connected and interviewed again when
 * next reached.
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
      where: { enabled: true, deletedAt: null },
    });

    this.logger.log(`Seeding gateway registry with ${gateways.length} enabled gateway(s)`);

    for (const gateway of gateways) {
      // A plugin DataGateway's row has no connection fields, so there is nothing to dial (#1083).
      const options = remoteConnectionOptions(gateway);
      if (!options) {
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
