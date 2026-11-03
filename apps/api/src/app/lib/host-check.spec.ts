import type { I18nPath } from '@bge/i18n';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHostCheck, type HostCheck } from './host-check';
import { createHostRule } from './host-rule';

const FORGED_FORWARDED_HOST = { 'x-forwarded-host': 'bge.example' };

function request(host: string | undefined, headers: Record<string, string> = {}): IncomingMessage {
  return { headers: { ...headers, ...(host === undefined ? {} : { host }) } } as unknown as IncomingMessage;
}

function response() {
  const headers = new Map<string, string>();
  const end = jest.fn();

  return {
    end,
    headers,
    body: () => JSON.parse(end.mock.calls[0][0]),
    res: {
      statusCode: 200,
      setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
      end,
    } as unknown as ServerResponse,
  };
}

describe('createHostCheck (#977)', () => {
  const warn = jest.fn();
  const render = (key: I18nPath) => `rendered:${key}`;

  beforeEach(() => warn.mockClear());

  const checkFor = (rule: (host: string | undefined) => boolean = (host) => host === 'bge.example'): HostCheck =>
    createHostCheck({ rule, render, logger: { warn } });

  /** Runs a request through the handler and reports what it did. */
  function handle(check: HostCheck, req: IncomingMessage) {
    const answer = response();
    const next = jest.fn();

    check.handler(req, answer.res, next);

    return { ...answer, next };
  }

  describe('handler', () => {
    it('passes an allowed Host on, and writes nothing', () => {
      const { next, end, headers, res } = handle(checkFor(), request('bge.example'));

      expect(next).toHaveBeenCalledTimes(1);
      expect(end).not.toHaveBeenCalled();
      expect(headers.size).toBe(0);
      expect(res.statusCode).toBe(200);
    });

    it('refuses another Host with a 421 and a stable code', () => {
      const { next, headers, res, body } = handle(checkFor(), request('evil.example'));

      expect(res.statusCode).toBe(421);
      expect(headers.get('content-type')).toBe('application/json');
      expect(body()).toEqual({ code: 'HOST_NOT_ALLOWED', message: 'rendered:errors.host.not_allowed' });
      expect(next).not.toHaveBeenCalled();
    });

    it('never echoes the refused name in the answer', () => {
      const { end, headers } = handle(checkFor(), request('evil.example'));

      expect(end.mock.calls[0][0]).not.toContain('evil.example');
      expect([...headers.values()].join()).not.toContain('evil.example');
    });

    // `trust proxy` makes req.hostname prefer X-Forwarded-Host, and a rebound
    // page can set that header on its own fetch.
    it('reads the Host header, not X-Forwarded-Host', () => {
      const { res, next } = handle(checkFor(), request('evil.example', FORGED_FORWARDED_HOST));

      expect(res.statusCode).toBe(421);
      expect(next).not.toHaveBeenCalled();
    });

    // The renderer logs an error when it fails, and this path takes no session,
    // so a render per refusal would get around the cap on the log.
    it('renders the message once, however many requests it refuses', () => {
      const render = jest.fn((key: I18nPath) => `rendered:${key}`);
      const check = createHostCheck({ rule: () => false, render, logger: { warn } });

      handle(check, request('evil.example'));
      check.allowRequest(request('evil.example'), jest.fn());

      expect(render).toHaveBeenCalledTimes(1);
    });

    it('refuses a 2,000-character Host without throwing', () => {
      const rule = createHostRule({
        publicUrl: 'https://bge.example',
        trustedOrigins: [],
        mediaBaseUrl: 'https://bge.example/api',
      });

      const { res, next } = handle(checkFor(rule), request('x'.repeat(2000)));

      expect(res.statusCode).toBe(421);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('the log of refused names', () => {
    it('logs each refused name once', () => {
      const check = checkFor();

      handle(check, request('evil.example'));
      handle(check, request('evil.example'));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('evil.example');
    });

    it('stops logging after 100 distinct names, and says so once', () => {
      const check = checkFor();

      for (let name = 0; name < 150; name++) {
        handle(check, request(`evil-${name}.example`));
      }

      expect(warn).toHaveBeenCalledTimes(101);
      expect(warn.mock.calls[99][0]).toContain('evil-99.example');
      expect(warn.mock.calls[100][0]).not.toContain('evil-100.example');
      expect(warn.mock.calls[100][0]).toMatch(/not logged/i);
    });

    // Outside traffic can fill the cap, and an operator who later adds a proxy or
    // a domain still needs to see which name is being refused.
    it('logs again after an hour, even once the cap was reached', () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(0);
      const check = checkFor();

      for (let name = 0; name < 150; name++) {
        handle(check, request(`evil-${name}.example`));
      }
      warn.mockClear();

      now.mockReturnValue(59 * 60 * 1000);
      handle(check, request('proxy-rewrite.example'));
      expect(warn).not.toHaveBeenCalled();

      now.mockReturnValue(60 * 60 * 1000);
      handle(check, request('proxy-rewrite.example'));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('proxy-rewrite.example');

      now.mockRestore();
    });

    it('truncates a logged name to 253 characters', () => {
      handle(checkFor(), request('x'.repeat(2000)));

      const [message] = warn.mock.calls[0];

      expect(message).toContain('x'.repeat(253));
      expect(message).not.toContain('x'.repeat(254));
    });

    it('shares one log between the handler and allowRequest', () => {
      const check = checkFor();

      handle(check, request('evil.example'));
      check.allowRequest(request('evil.example'), jest.fn());

      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('allowRequest', () => {
    it('answers with the code and message on a refusal', () => {
      const callback = jest.fn();

      checkFor().allowRequest(request('evil.example'), callback);

      expect(callback).toHaveBeenCalledWith('HOST_NOT_ALLOWED: rendered:errors.host.not_allowed', false);
    });

    it('answers with success for an allowed Host', () => {
      const callback = jest.fn();

      checkFor().allowRequest(request('bge.example'), callback);

      expect(callback).toHaveBeenCalledWith(undefined, true);
    });

    it('reads the Host header, not X-Forwarded-Host', () => {
      const callback = jest.fn();

      checkFor().allowRequest(request('evil.example', FORGED_FORWARDED_HOST), callback);

      expect(callback).toHaveBeenCalledWith(expect.stringContaining('HOST_NOT_ALLOWED'), false);
    });
  });
});
