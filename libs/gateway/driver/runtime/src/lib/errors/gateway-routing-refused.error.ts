import type { DataGatewayCapability } from '@bge/database';

/**
 * Why the gateway registry won't use a DataGateway:
 * - `unknown`: there's no such DataGateway, or it was deleted;
 * - `disabled`: an admin disabled it, or repeated failures auto-disabled it;
 * - `not_interviewed`: its first interview hasn't succeeded yet;
 * - `not_declared`: it doesn't declare the capability;
 * - `switched_off`: an admin switched the capability off for it.
 */
export type GatewayRefusalReason = 'unknown' | 'disabled' | 'not_interviewed' | 'not_declared' | 'switched_off';

const MESSAGES: Readonly<Record<GatewayRefusalReason, (gatewayId: string, capability?: string) => string>> = {
  unknown: (gatewayId) => `DataGateway ${gatewayId} doesn't exist, or was deleted`,
  disabled: (gatewayId) => `DataGateway ${gatewayId} is disabled`,
  not_interviewed: (gatewayId) => `DataGateway ${gatewayId} hasn't passed its first interview`,
  not_declared: (gatewayId, capability) => `DataGateway ${gatewayId} doesn't declare ${capability}`,
  switched_off: (gatewayId, capability) => `An admin switched ${capability} off for DataGateway ${gatewayId}`,
};

/**
 * The gateway registry's refusal to use a DataGateway: to route a capability
 * to it, or, without a capability, to interview it on request. Callers
 * answer it as they answer a DataGateway that's unavailable, and it never
 * counts toward auto-disable, since the DataGateway did nothing wrong.
 */
export class GatewayRoutingRefusedError extends Error {
  constructor(
    readonly gatewayId: string,
    readonly reason: GatewayRefusalReason,
    readonly capability?: DataGatewayCapability,
  ) {
    super(MESSAGES[reason](gatewayId, capability));
    this.name = GatewayRoutingRefusedError.name;
  }
}
