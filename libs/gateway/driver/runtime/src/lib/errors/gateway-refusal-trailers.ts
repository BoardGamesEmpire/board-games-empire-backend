import { DataGatewayCapability } from '@bge/database';
import { Metadata, status } from '@grpc/grpc-js';
import { GatewayRoutingRefusedError, isGatewayRefusalReason } from './gateway-routing-refused.error';

/** The trailer that names why the gateway registry refused a call it routes for another process (#1083). */
export const GATEWAY_REFUSAL_REASON_TRAILER = 'bge-gateway-refusal-reason';

/** The trailer that names the capability a refusal was about, when it was about one (#1083). */
export const GATEWAY_REFUSAL_CAPABILITY_TRAILER = 'bge-gateway-refusal-capability';

/**
 * The gRPC status a refusal answers with: NOT_FOUND for a DataGateway the
 * gateway registry doesn't know, which isn't there to whoever names it, and
 * FAILED_PRECONDITION for any other, of one that exists and may not serve the
 * call as things stand.
 */
export const refusalStatusCode = (refusal: GatewayRoutingRefusedError): status =>
  refusal.reason === 'unknown' ? status.NOT_FOUND : status.FAILED_PRECONDITION;

/**
 * The trailers a refused call answers with, beside its status (#1083). The
 * coordinator routes each call the gateway worker relays to a plugin
 * DataGateway, and its gateway registry may refuse one the gateway worker's
 * let through: the plugin was switched off, or a capability, in between.
 * The status alone can't tell that refusal from a driver's own error with the
 * same status, which counts toward auto-disable. These can, and
 * {@link refusalFromCallError} reads them back.
 */
export function refusalTrailers(refusal: GatewayRoutingRefusedError): Metadata {
  const trailers = new Metadata();
  trailers.set(GATEWAY_REFUSAL_REASON_TRAILER, refusal.reason);

  if (refusal.capability !== undefined) {
    trailers.set(GATEWAY_REFUSAL_CAPABILITY_TRAILER, refusal.capability);
  }

  return trailers;
}

const isCapability = (value: unknown): value is DataGatewayCapability =>
  (Object.values(DataGatewayCapability) as unknown[]).includes(value);

/** The first value of `key` in `trailers`, when there is one. */
const firstValue = (trailers: Metadata, key: string): unknown => trailers.get(key)[0];

/**
 * The refusal a failed gRPC call answered with, as the error the gateway
 * registry raises for its own refusals, or undefined when the call failed
 * any other way (#1083). Read from {@link refusalTrailers}: a refusal status
 * that carries no reason, or one this process doesn't know, is not taken for
 * a refusal, and stays an error that counts.
 */
export function refusalFromCallError(gatewayId: string, error: unknown): GatewayRoutingRefusedError | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error) || !('metadata' in error)) {
    return undefined;
  }

  const { code, metadata } = error;

  if ((code !== status.NOT_FOUND && code !== status.FAILED_PRECONDITION) || !(metadata instanceof Metadata)) {
    return undefined;
  }

  const reason = firstValue(metadata, GATEWAY_REFUSAL_REASON_TRAILER);

  if (!isGatewayRefusalReason(reason)) {
    return undefined;
  }

  const capability = firstValue(metadata, GATEWAY_REFUSAL_CAPABILITY_TRAILER);

  return new GatewayRoutingRefusedError(gatewayId, reason, isCapability(capability) ? capability : undefined);
}
