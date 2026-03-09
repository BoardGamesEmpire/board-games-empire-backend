import type { AuthType, Prisma } from '@bge/database';

export interface GatewayConnectionOptions {
  gatewayId: string;
  connectionUrl: string;
  connectionPort: number;
  authType: AuthType;
  authParameters?: Prisma.JsonValue;
}
