import { isOperationalRequest } from '@bge/health';
import helmet from 'helmet';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * helmet's security headers, chosen by the listener that accepted the request
 * (#1511).
 *
 * The public port gets helmet's defaults, as it always has. The operational
 * port is plain HTTP, reached at a private address, so two of those defaults
 * would only get in the way there: the content security policy's
 * `upgrade-insecure-requests` has the browser fetch the API document page's
 * script and style over `https://`, which the port doesn't serve, leaving the
 * page blank; and HSTS, which a browser ignores over plain HTTP anyway. The
 * operational port gets the defaults without those two.
 */
export function createSecurityHeaders(): (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void {
  const publicHeaders = helmet();
  const operationalHeaders = helmet({
    contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    strictTransportSecurity: false,
  });

  return (req, res, next) => (isOperationalRequest(req) ? operationalHeaders : publicHeaders)(req, res, next);
}
