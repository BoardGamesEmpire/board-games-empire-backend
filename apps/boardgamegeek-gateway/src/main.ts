import 'reflect-metadata';

import { bootstrapGrpcGateway } from '@bge/gateway-host';
import * as path from 'node:path';
import { AppModule } from './app/app.module';
import { bootstrapLogger } from './app/lib/logger';

void bootstrapGrpcGateway({
  appModule: AppModule,
  displayName: 'BoardgamesEmpire BoardgameGeek Gateway',
  hostEnv: 'BOARDGAMEGEEK_GATEWAY_GRPC_HOST',
  portEnv: 'BOARDGAMEGEEK_GATEWAY_GRPC_PORT',
  protoDir: path.join(__dirname, 'proto'),
  bootstrapLogger,
});
