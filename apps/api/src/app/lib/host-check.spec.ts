import type { I18nPath } from '@bge/i18n';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostCheck } from './host-check';
import { createHostCheck } from './host-check';
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
      expect(body()).toEqual({
        statusCode: 421,
        error: 'Misdirected Request',
        code: 'HOST_NOT_ALLOWED',
        message: 'rendered:errors.host.not_allowed',
      });
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

    it('truncates a logged name to 253 characters', () => {
      handle(checkFor(), request('x'.repeat(2000)));

      const [message] = warn.mock.calls[0];

      expect(message).toContain('x'.repeat(253));
      expect(message).not.toContain('x'.repeat(254));
    });

    // The operator acts on these two lines, so their wording is pinned here;
    // the cap and the hourly reset are refusal-log.spec.ts's (#977, #1511).
    it('logs a refused name, and the cap, in the exact words an operator reads', () => {
      const check = checkFor();

      for (let i = 0; i <= 100; i += 1) {
        handle(check, request(`evil-${i}.example`));
      }

      expect(warn).toHaveBeenCalledTimes(101);
      expect(warn.mock.calls[0][0]).toBe(
        "Refused a request for 'evil-0.example'. If this server answers there, add it to TRUSTED_ORIGINS",
      );
      expect(warn.mock.calls[100][0]).toBe(
        'Refused requests for 100 different names. Others are not logged for up to an hour',
      );
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
