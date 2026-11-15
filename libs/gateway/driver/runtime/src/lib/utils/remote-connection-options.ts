import type { DataGateway } from '@bge/database';
import type { GatewayConnectionOptions } from '../interfaces';

type ConnectionRow = Pick<DataGateway, 'id' | 'connectionUrl' | 'connectionPort' | 'authType' | 'authParameters'>;

/**
 * How a remote DataGateway's row says to reach it, or null for a row with no
 * connection fields: a plugin DataGateway's, which is never dialled (#1083).
 */
export function remoteConnectionOptions(gateway: ConnectionRow): GatewayConnectionOptions | null {
  const { connectionUrl, connectionPort, authType } = gateway;

  if (connectionUrl === null || connectionPort === null || authType === null) {
    return null;
  }

  return {
    gatewayId: gateway.id,
    connectionUrl,
    connectionPort,
    authType,
    authParameters: gateway.authParameters ?? undefined,
  };
}
