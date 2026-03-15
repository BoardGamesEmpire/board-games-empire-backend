import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SearchGateway } from './search.gateway';

@Module({
  imports: [DatabaseModule, GatewayCoordinatorClientModule, JwtModule.register({})],
  providers: [SearchGateway],
})
export class SearchGatewayModule {}
