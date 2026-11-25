import type { IncomingMessage } from 'node:http';
import { isOperationalRequest, markOperationalRequest } from './operational-request';

const request = () => ({ headers: {} }) as unknown as IncomingMessage;

describe('the operational request mark (#1511)', () => {
  it('is absent on a request no listener marked', () => {
    expect(isOperationalRequest(request())).toBe(false);
  });

  it('is present once the operational listener marks the request', () => {
    const req = request();

    markOperationalRequest(req);

    expect(isOperationalRequest(req)).toBe(true);
  });

  it('marks only the request it was given', () => {
    const marked = request();
    const other = request();

    markOperationalRequest(marked);

    expect(isOperationalRequest(other)).toBe(false);
  });
});
