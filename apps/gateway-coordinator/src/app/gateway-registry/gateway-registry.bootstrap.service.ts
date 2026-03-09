import { DatabaseService } from '@bge/database';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GatewayRegistryService } from './gateway-registry.service';

@Injectable()
export class GatewayRegistryBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(GatewayRegistryBootstrapService.name);

  constructor(private readonly db: DatabaseService, private readonly registry: GatewayRegistryService) {}

  async onModuleInit(): Promise<void> {
    const gateways = await this.db.gameGateway.findMany({
      where: { enabled: true },
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
        // TODO: notification
        this.logger.error(
          `Failed to connect gateway '${gateway.name}' (${gateway.id}) during bootstrap`,
          error instanceof Error ? error.stack : error,
        );
      }
    }

    this.logger.log(`Registry seeded. Connected: [${this.registry.connectedGatewayIds().join(', ')}]`);
  }
}
