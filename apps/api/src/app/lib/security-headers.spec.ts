import { markOperationalRequest } from '@bge/health';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSecurityHeaders } from './security-headers';

/** The headers the middleware sets on one request, by lower-cased name. */
function headersFor(operational: boolean): Record<string, string> {
  const req = {} as IncomingMessage;
  if (operational) {
    markOperationalRequest(req);
  }

  const headers: Record<string, string> = {};
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = String(value);
    },
    removeHeader: (name: string) => {
      delete headers[name.toLowerCase()];
    },
  } as unknown as ServerResponse;
  const next = jest.fn();

  createSecurityHeaders()(req, res, next);

  expect(next).toHaveBeenCalledWith();
  return headers;
}

describe('createSecurityHeaders (#1511)', () => {
  it("gives the public port helmet's defaults, upgrade-insecure-requests and HSTS included", () => {
    const headers = headersFor(false);

    expect(headers['content-security-policy']).toContain('upgrade-insecure-requests');
    expect(headers['strict-transport-security']).toBeDefined();
  });

  // The operational port is plain HTTP: an upgrade would send the API
  // document page's script and style to an https:// the port doesn't serve.
  it('leaves upgrade-insecure-requests and HSTS off the operational port, and keeps the rest', () => {
    const headers = headersFor(true);

    expect(headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers).not.toHaveProperty('strict-transport-security');
    expect(headers['x-content-type-options']).toBe('nosniff');
  });
});
