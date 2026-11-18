import type { AuthType, Prisma } from '@bge/database';

export interface GatewayConnectionOptions {
  authParameters?: Prisma.JsonValue;
  authType: AuthType;
  connectionPort: number;
  connectionUrl: string;
  gatewayId: string;
}
