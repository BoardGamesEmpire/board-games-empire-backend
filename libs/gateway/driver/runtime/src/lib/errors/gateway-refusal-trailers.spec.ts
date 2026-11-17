import { DataGatewayCapability } from '@bge/database';
import { Metadata, status } from '@grpc/grpc-js';
import {
  GATEWAY_REFUSAL_CAPABILITY_TRAILER,
  GATEWAY_REFUSAL_REASON_TRAILER,
  refusalFromCallError,
  refusalStatusCode,
  refusalTrailers,
} from './gateway-refusal-trailers';
import { GatewayRoutingRefusedError } from './gateway-routing-refused.error';

const GW = 'acme';

/** A failed call as a gRPC client reports it: the status code, and the trailers it ended with. */
const callError = (code: status, metadata: Metadata = new Metadata()): Error =>
  Object.assign(new Error(`${code} ${status[code]}`), { code, metadata });

/** The error the call the coordinator answered with `refusal` reports to the gateway worker. */
const answeredWith = (refusal: GatewayRoutingRefusedError): Error =>
  callError(refusalStatusCode(refusal), refusalTrailers(refusal));

// The coordinator routes each call the gateway worker relays to a plugin
// DataGateway, and may refuse one the gateway worker let through. A refusal
// counts toward no auto-disable, so the gateway worker must tell it from a
// driver's own error with the same status (#1083).
describe('refusals carried across a relayed call (#1083)', () => {
  it('answers a DataGateway the registry does not know as NOT_FOUND, and any other refusal as FAILED_PRECONDITION (#1083)', () => {
    expect(refusalStatusCode(new GatewayRoutingRefusedError(GW, 'unknown'))).toBe(status.NOT_FOUND);
    expect(refusalStatusCode(new GatewayRoutingRefusedError(GW, 'switched_off'))).toBe(status.FAILED_PRECONDITION);
  });

  it('reads back the reason and the capability a refusal named (#1083)', () => {
    const refusal = new GatewayRoutingRefusedError(GW, 'switched_off', DataGatewayCapability.Fetch);

    const readBack = refusalFromCallError(GW, answeredWith(refusal));

    expect(readBack).toBeInstanceOf(GatewayRoutingRefusedError);
    expect(readBack).toMatchObject({ gatewayId: GW, reason: 'switched_off', capability: DataGatewayCapability.Fetch });
    expect(readBack?.message).toBe(refusal.message);
  });

  it('reads back a refusal that named no capability (#1083)', () => {
    const readBack = refusalFromCallError(GW, answeredWith(new GatewayRoutingRefusedError(GW, 'plugin_not_loaded')));

    expect(readBack).toMatchObject({ reason: 'plugin_not_loaded', capability: undefined });
  });

  // A driver's own FAILED_PRECONDITION is relayed unchanged, with no trailers.
  it.each([status.FAILED_PRECONDITION, status.NOT_FOUND])(
    'takes status %d with no refusal trailer for no refusal (#1083)',
    (code) => {
      expect(refusalFromCallError(GW, callError(code))).toBeUndefined();
    },
  );

  it('takes a reason it does not know for no refusal (#1083)', () => {
    const trailers = new Metadata();
    trailers.set(GATEWAY_REFUSAL_REASON_TRAILER, 'out_of_coffee');

    expect(refusalFromCallError(GW, callError(status.FAILED_PRECONDITION, trailers))).toBeUndefined();
  });

  it('takes a refusal trailer on any other status for no refusal (#1083)', () => {
    const trailers = refusalTrailers(new GatewayRoutingRefusedError(GW, 'disabled'));

    expect(refusalFromCallError(GW, callError(status.UNAVAILABLE, trailers))).toBeUndefined();
  });

  it('leaves out a capability it does not know, and keeps the refusal (#1083)', () => {
    const trailers = new Metadata();
    trailers.set(GATEWAY_REFUSAL_REASON_TRAILER, 'not_declared');
    trailers.set(GATEWAY_REFUSAL_CAPABILITY_TRAILER, 'Teleport');

    expect(refusalFromCallError(GW, callError(status.FAILED_PRECONDITION, trailers))).toMatchObject({
      reason: 'not_declared',
      capability: undefined,
    });
  });

  it.each([undefined, null, 'FAILED_PRECONDITION', new Error('no status at all')])(
    'takes %p for no refusal (#1083)',
    (error) => {
      expect(refusalFromCallError(GW, error)).toBeUndefined();
    },
  );
});
