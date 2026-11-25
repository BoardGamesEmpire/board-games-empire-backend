import { HostNotAllowedError, OutboundNetworkError, SecureHttpService } from '@bge/secure-http';
import { TerminusModule } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import { HttpTargetHealthIndicator } from './http-target.health-indicator';

type MockSecureHttp = { request: jest.Mock };

async function buildIndicator(secureHttp: MockSecureHttp): Promise<HttpTargetHealthIndicator> {
  const module = await Test.createTestingModule({
    imports: [TerminusModule],
    providers: [HttpTargetHealthIndicator, { provide: SecureHttpService, useValue: secureHttp }],
  }).compile();

  return module.get(HttpTargetHealthIndicator);
}

function answering(status: number): MockSecureHttp {
  return { request: jest.fn().mockResolvedValue({ status }) };
}

describe('HttpTargetHealthIndicator (#1509)', () => {
  it.each([200, 204, 301, 399])('reports up for a %i answer', async (status) => {
    const indicator = await buildIndicator(answering(status));

    await expect(indicator.check('site', 'https://example.com')).resolves.toEqual({ site: { status: 'up' } });
  });

  it.each([400, 404, 500, 503])('reports down with the status code for a %i answer', async (status) => {
    const indicator = await buildIndicator(answering(status));

    await expect(indicator.check('site', 'https://example.com')).resolves.toEqual({
      site: { status: 'down', statusCode: status },
    });
  });

  it('reports down with the error code when the outbound HTTP policy refuses the host', async () => {
    const secureHttp = { request: jest.fn().mockRejectedValue(new HostNotAllowedError('10.0.0.5')) };
    const indicator = await buildIndicator(secureHttp);

    await expect(indicator.check('site', 'http://10.0.0.5')).resolves.toEqual({
      site: { status: 'down', code: 'OUTBOUND_HOST_NOT_ALLOWED' },
    });
  });

  it('reports down with the error code for any other outbound HTTP failure', async () => {
    const secureHttp = {
      request: jest.fn().mockRejectedValue(new OutboundNetworkError('https://example.com', new Error('refused'))),
    };
    const indicator = await buildIndicator(secureHttp);

    await expect(indicator.check('site', 'https://example.com')).resolves.toEqual({
      site: { status: 'down', code: 'OUTBOUND_NETWORK_ERROR' },
    });
  });

  it('rethrows an error that is not an outbound HTTP failure', async () => {
    const bug = new TypeError('not a request error');
    const indicator = await buildIndicator({ request: jest.fn().mockRejectedValue(bug) });

    await expect(indicator.check('site', 'https://example.com')).rejects.toBe(bug);
  });

  it('sends a GET that keeps the body as bytes, with a five second limit', async () => {
    const secureHttp = answering(200);
    const indicator = await buildIndicator(secureHttp);

    await indicator.check('site', 'https://example.com');

    expect(secureHttp.request).toHaveBeenCalledWith('https://example.com', {
      method: 'GET',
      responseType: 'arraybuffer',
      timeoutMs: 5000,
    });
  });
});
