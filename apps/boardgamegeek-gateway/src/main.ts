import 'reflect-metadata';

import { bootstrapGrpcGateway } from '@bge/gateway-host';
import * as path from 'node:path';
import { AppModule } from './app/app.module';
import gatewayConfig from './app/configuration/gateway.config';
import { bootstrapLogger } from './app/lib/logger';

void bootstrapGrpcGateway({
  appModule: AppModule,
  displayName: 'BoardgamesEmpire BoardgameGeek Gateway',
  addressConfig: gatewayConfig,
  protoDir: path.join(__dirname, 'proto'),
  bootstrapLogger,
});
