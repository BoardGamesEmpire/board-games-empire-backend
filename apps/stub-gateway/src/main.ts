import 'reflect-metadata';

import { bootstrapGrpcGateway } from '@bge/gateway-host';
import * as path from 'node:path';
import { AppModule } from './app/app.module';
import gatewayConfig from './app/configuration/gateway.config';
import { bootstrapLogger } from './app/lib/logger';

/**
 * A game gateway for tests: it serves the gateway proto from fixtures and
 * calls no upstream, so a search or an import can reach a gateway with no
 * credentials and no network (#600, #611). It boots through the same
 * bootstrap as the real gateways, so a host meets it exactly as it meets
 * them: a gRPC server it registers, pings and dials by address.
 */
void bootstrapGrpcGateway({
  appModule: AppModule,
  displayName: 'BoardgamesEmpire Stub Gateway',
  addressConfig: gatewayConfig,
  protoDir: path.join(__dirname, 'proto'),
  bootstrapLogger,
});
