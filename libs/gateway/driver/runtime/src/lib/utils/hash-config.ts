import type { DataGateway } from '@bge/database';

type ConfigOptions = Pick<DataGateway, 'connectionUrl' | 'connectionPort' | 'authType'> &
  Partial<Pick<DataGateway, 'authParameters'>>;

/**
 * Deterministic hash over the fields that affect gateway client behavior.
 * Used by the registry to detect when a config update actually requires
 * reconnecting, and by config-event publishers to populate the hash field
 * on the published payload.
 *
 * A plugin DataGateway's row has none of these fields, and hashes to one
 * value: nothing an admin can change on it calls for a new driver (#1083).
 */
export function hashGatewayConfig(gateway: ConfigOptions): string {
  return [
    gateway.connectionUrl,
    gateway.connectionPort,
    gateway.authType,
    JSON.stringify(gateway.authParameters ?? {}),
  ].join('|');
}
