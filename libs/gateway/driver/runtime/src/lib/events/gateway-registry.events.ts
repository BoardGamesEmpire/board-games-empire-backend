import { MutationEvent } from '@bge/actor-context';
import { ResourceType, type DataGateway } from '@bge/database';
import { GATEWAY_CAPABILITIES_CHANGED_EVENT, GATEWAY_DISABLED_EVENT } from '../constants/gateway-registry.constants';

/**
 * Domain mutation events for the gateway registry (#57 emit-site migration).
 *
 * This covers the in-process (EventEmitter2) events only: auto-disable, and a
 * DataGateway's capabilities changing at an interview. The Redis pub/sub
 * config-invalidation channel (`GatewayConfigEventsService`) is a transport
 * concern and stays interface-based.
 */

/**
 * Which failure path tripped the auto-disable threshold.
 */
export type GatewayAutoDisableReason = 'repeated_connection_failure' | 'repeated_call_failure';

/**
 * Failure-tracking context carried for admin notifications — not row state.
 */
export interface GatewayAutoDisableFailure {
  readonly reason: GatewayAutoDisableReason;
  readonly consecutiveFailures: number;
  readonly firstFailureAt: Date;
  readonly lastFailureAt: Date;
  readonly lastError: string;
}

type GatewayDisabledSnapshot = Readonly<Pick<DataGateway, 'id' | 'enabled'>>;

/**
 * Emitted when repeated failures auto-disable a gateway. Update-shaped:
 * the conditional write (`where: { enabled: true }`) proves the before
 * state, so before/after carry the `enabled` flip.
 */
export class GatewayDisabledEvent extends MutationEvent<DataGateway> {
  static readonly eventName = GATEWAY_DISABLED_EVENT;

  declare readonly before: GatewayDisabledSnapshot;
  declare readonly after: GatewayDisabledSnapshot;

  readonly subject = ResourceType.DataGateway;
  readonly subjectId: string;

  constructor(
    before: GatewayDisabledSnapshot,
    after: GatewayDisabledSnapshot,
    public readonly failure: GatewayAutoDisableFailure,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type GatewayCapabilitiesSnapshot = Readonly<Pick<DataGateway, 'id' | 'capabilities'>>;

/**
 * Emitted when an interview stores capabilities that differ from the ones
 * before it, the first interview's included. A capability that's gone is
 * routed no longer, and a new one is routed at once. The write is
 * conditional on the list it replaces, so when several processes store the
 * same change, only the one whose write lands emits.
 */
export class GatewayCapabilitiesChangedEvent extends MutationEvent<DataGateway> {
  static readonly eventName = GATEWAY_CAPABILITIES_CHANGED_EVENT;

  declare readonly before: GatewayCapabilitiesSnapshot;
  declare readonly after: GatewayCapabilitiesSnapshot;

  readonly subject = ResourceType.DataGateway;
  readonly subjectId: string;

  constructor(before: GatewayCapabilitiesSnapshot, after: GatewayCapabilitiesSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}
