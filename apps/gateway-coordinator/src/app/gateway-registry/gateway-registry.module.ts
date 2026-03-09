import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { GatewayCredentialsFactory } from './credentials/gateway-credentials.factory';
import { GatewayRegistryBootstrapService } from './gateway-registry.bootstrap.service';
import { GatewayRegistryService } from './gateway-registry.service';

@Module({
  imports: [DatabaseModule],
  providers: [GatewayCredentialsFactory, GatewayRegistryService, GatewayRegistryBootstrapService],
  exports: [GatewayRegistryService],
})
export class GatewayRegistryModule {}
