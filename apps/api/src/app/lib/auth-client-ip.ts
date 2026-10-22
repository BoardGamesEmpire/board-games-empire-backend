import { AUTH_CLIENT_IP_HEADER } from '@bge/auth';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createClientIpResolver } from './ip-tracker';

/**
 * The handler `main.ts` mounts ahead of better-auth's routes (#640). It writes
 * the client's address, by the Nest throttler's rule, into the header
 * better-auth reads it from ({@link AUTH_CLIENT_IP_HEADER}), over any value
 * the client sent.
 *
 * better-auth can't work the address out itself. It never reads the
 * connection's address, and it believes `X-Forwarded-For` only when the header
 * holds a single entry, which a client reaching the api directly can write.
 * Without a header it believes, every client shares one rate-limit bucket in
 * production: after any three sign-in attempts within ten seconds, everyone's
 * next one would be refused.
 *
 * It runs on the raw Express server, as better-auth does, and reads only the
 * socket and the headers, so better-auth still gets the raw body.
 */
export const createAuthClientIpHandler = (trustedHops: number) => {
  const resolve = createClientIpResolver(trustedHops);

  return (req: IncomingMessage, _res: ServerResponse, next: () => void): void => {
    req.headers[AUTH_CLIENT_IP_HEADER] = resolve(req);
    next();
  };
};
