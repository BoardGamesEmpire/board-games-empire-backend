import { DatabaseService } from '@bge/database';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { GatewayRegistryService } from './gateway-registry.service';

/**
 * Eagerly connects to all enabled gateways once the application is fully
 * bootstrapped. Uses OnApplicationBootstrap (not OnModuleInit) so that
 * Test.createTestingModule().compile() does NOT trigger gateway connection
 * attempts — only real app starts via app.init() / app.listen() do.
 */
@Injectable()
export class GatewayRegistryBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(GatewayRegistryBootstrapService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: GatewayRegistryService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const gateways = await this.db.gameGateway.findMany({
      where: { enabled: true, deletedAt: null },
    });

    this.logger.log(`Seeding gateway registry with ${gateways.length} enabled gateway(s)`);

    for (const gateway of gateways) {
      try {
        await this.registry.connect({
          gatewayId: gateway.id,
          connectionUrl: gateway.connectionUrl,
          connectionPort: gateway.connectionPort,
          authType: gateway.authType,
          authParameters: gateway.authParameters ?? undefined,
        });

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
