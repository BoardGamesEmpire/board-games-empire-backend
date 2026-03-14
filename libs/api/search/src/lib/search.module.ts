import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { SearchGateway } from './search.gateway';

@Module({
  imports: [DatabaseModule, GatewayCoordinatorClientModule],
  providers: [SearchGateway],
})
export class SearchGatewayModule {}
