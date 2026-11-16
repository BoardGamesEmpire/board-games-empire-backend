import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { ServicesModule } from '@bge/services';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import bgeIdentityConfig from './configuration/bge-identity.config';
import securityTxtConfig from './configuration/security-txt.config';
import { DiscoveryController } from './discovery.controller';
import { SecurityTxtService } from './security-txt.service';
import { ServerDiscoveryService } from './server-discovery.service';
import { StrategyService } from './strategy.service';
import { WellKnownController } from './well-known.controller';

@Module({
  imports: [
    ConfigModule.forFeature(securityTxtConfig),
    ConfigModule.forFeature(bgeIdentityConfig),
    // Supplies AuditContextService to DiscoveryController, which reads the
    // request locale to name the running plugins in it (#78).
    AuditContextModule,
    DatabaseModule,
    ServicesModule,
    // No import for ServerDiscoveryService's PluginInventoryService: the
    // plugin runtime is a global module, configured once by the host's
    // forRootAsync, and a static import here would build a second one.
  ],
  controllers: [WellKnownController, DiscoveryController],
  providers: [StrategyService, SecurityTxtService, ServerDiscoveryService],
})
export class WellKnownModule {}
