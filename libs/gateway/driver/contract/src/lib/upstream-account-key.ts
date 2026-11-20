import type * as proto from '@boardgamesempire/proto-gateway';
import type { Observable } from 'rxjs';
import { throwError } from 'rxjs';
import { GRPC_STATUS_INVALID_ARGUMENT, grpcStatusError } from './driver-observables.js';

/** The one key a FindUpstreamAccount request looks an upstream account up by (#1226). */
export type UpstreamAccountKey = { readonly username: string } | { readonly externalId: string };

/**
 * The key a FindUpstreamAccount request names: exactly one of a username and
 * an external ID, and not an empty one. Undefined when it names neither, or
 * both: over gRPC the request's oneof carries at most one, so a request with
 * both was built in-process, and a lookup can't tell which it meant (#1226).
 */
export function upstreamAccountKeyOf(request: proto.FindUpstreamAccountRequest): UpstreamAccountKey | undefined {
  const username = request.username || undefined;
  const externalId = request.externalId || undefined;

  if (username !== undefined && externalId === undefined) {
    return { username };
  }

  if (externalId !== undefined && username === undefined) {
    return { externalId };
  }

  return undefined;
}

/**
 * What a driver answers a FindUpstreamAccount request that names no key it
 * can look up by: INVALID_ARGUMENT, which the shared gRPC controller sends as
 * the call's status (#1226).
 */
export const invalidUpstreamAccountKey = (): Observable<never> =>
  throwError(() =>
    grpcStatusError(
      GRPC_STATUS_INVALID_ARGUMENT,
      'FindUpstreamAccount needs exactly one of a username and an external ID',
    ),
  );
