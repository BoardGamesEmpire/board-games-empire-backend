import { MutationEvent } from '@bge/actor-context';
import { ResourceType, type GameGateway } from '@bge/database';
import { GATEWAY_DISABLED_EVENT } from '../constants/gateway-registry.constants';

/**
 * Domain mutation events for the gateway registry (#57 emit-site migration).
 *
 * This covers the in-process (EventEmitter2) auto-disable event only — the
 * Redis pub/sub config-invalidation channel (`GatewayConfigEventsService`)
 * is a transport concern and stays interface-based.
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

type GatewayDisabledSnapshot = Readonly<Pick<GameGateway, 'id' | 'enabled'>>;

/**
 * Emitted when repeated failures auto-disable a gateway. Update-shaped:
 * the conditional write (`where: { enabled: true }`) proves the before
 * state, so before/after carry the `enabled` flip.
 */
export class GatewayDisabledEvent extends MutationEvent<GameGateway> {
  static readonly eventName = GATEWAY_DISABLED_EVENT;

  declare readonly before: GatewayDisabledSnapshot;
  declare readonly after: GatewayDisabledSnapshot;

  readonly subject = ResourceType.GameGateway;
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
