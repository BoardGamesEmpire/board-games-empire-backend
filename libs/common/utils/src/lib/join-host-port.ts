import { isIPv6 } from 'node:net';

/**
 * Joins a host and port into the `host:port` form gRPC addresses take. An
 * IPv6 host is bracketed, as in `[::1]:50051`: unbracketed, gRPC reads every
 * colon as part of the host and finds no port.
 */
export function joinHostPort(host: string, port: number): string {
  return isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
}
