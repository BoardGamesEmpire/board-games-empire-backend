import type { GameGateway } from '@bge/database';

type ConfigOptions = Pick<GameGateway, 'connectionUrl' | 'connectionPort' | 'authType'> &
  Partial<Pick<GameGateway, 'authParameters'>>;

/**
 * Deterministic hash over the fields that affect gateway client behavior.
 * Used by the registry to detect when a config update actually requires
 * reconnecting, and by config-event publishers to populate the hash field
 * on the published payload.
 */
export function hashGatewayConfig(gateway: ConfigOptions): string {
  return [
    gateway.connectionUrl,
    gateway.connectionPort,
    gateway.authType,
    JSON.stringify(gateway.authParameters ?? {}),
  ].join('|');
}
