import { Injectable } from '@nestjs/common';
import { Agent, type Dispatcher } from 'undici';
import { IpFamily } from './ip';

/**
 * Constructs the undici `Dispatcher` used by `SecureHttpService` for a
 * single HTTP hop. Extracted from the service so tests can inject a
 * `MockAgent`-backed factory — `undici.MockAgent` intercepts at the
 * Dispatcher layer, and the service passes its dispatcher explicitly per
 * request rather than through `setGlobalDispatcher`, so the only seam for
 * mocking is this factory.
 *
 * Production behavior: builds a fresh `Agent` per hop with the resolved
 * IP pinned via `connect.lookup`. The lookup override returns the
 * pre-validated IP regardless of hostname asked, closing the rebind
 * window between SSRF evaluation and TCP connect. TLS SNI and the HTTP
 * `Host` header still derive from the URL's hostname, so cert verification
 * and vhost routing work against the intended host.
 */
@Injectable()
export class HttpDispatcherFactory {
  build(pinnedIp: string, family: IpFamily, timeoutMs: number): Dispatcher {
    return new Agent({
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      connect: {
        lookup: (_hostname: string, _options: unknown, callback: LookupCallback) => {
          callback(null, pinnedIp, family);
        },
      },
    });
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string, family: IpFamily) => void;
