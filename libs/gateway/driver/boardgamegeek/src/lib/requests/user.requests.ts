import { fromAbortable } from '@boardgamesempire/gateway-driver-contract';
import type { BggRequest } from '../client/bgg-client.interface';
import type { BggUser } from '../types';

/**
 * Look a BGG user up by name, or `undefined` when BGG has no user by it
 * (#1226). The client asks again on each subscription, so a retry re-asks.
 */
export function findUserRequest(name: string): BggRequest<BggUser | undefined> {
  return (client) => fromAbortable((signal) => client.user.query({ name }, signal));
}
