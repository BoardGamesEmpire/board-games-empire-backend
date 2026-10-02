import type { AuthService } from '@bge/auth';
import { isI18nMessage } from '@bge/i18n';
import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { connectionCredential, WsSessionGuard } from './ws-session';

const COOKIE = 'bge_auth_.session_token=cookie-token.signature; theme=dark';

const handshake = (auth: Record<string, unknown>, headers: Record<string, string> = {}) => ({
  auth,
  headers: { 'accept-language': 'fr', origin: 'https://app.example', 'user-agent': 'test', ...headers },
});

describe('connectionCredential', () => {
  it('is the `auth.token`, sent as a bearer and nothing else, even beside an Authorization header and a cookie', () => {
    const credential = connectionCredential(
      handshake({ token: 'the-token' }, { authorization: 'Bearer other-token', cookie: COOKIE }),
    );

    expect(credential).toEqual({ channel: 'token', headers: { authorization: 'Bearer the-token' } });
  });

  it('is the Authorization header alone when no token is sent, even beside a cookie', () => {
    const credential = connectionCredential(handshake({}, { authorization: 'Bearer header-token', cookie: COOKIE }));

    expect(credential).toEqual({ channel: 'authorization', headers: { authorization: 'Bearer header-token' } });
  });

  it('is the cookie alone when neither a token nor an Authorization header is sent', () => {
    const credential = connectionCredential(handshake({}, { cookie: COOKIE }));

    expect(credential).toEqual({ channel: 'cookie', headers: { cookie: COOKIE } });
  });

  it.each([
    ['an empty string', ''],
    ['a number', 42],
    ['an object', { token: 'nested' }],
    ['null', null],
  ])('reads %s sent as the token as no token', (_, token) => {
    expect(connectionCredential(handshake({ token }, { cookie: COOKIE }))).toEqual({
      channel: 'cookie',
      headers: { cookie: COOKIE },
    });
  });

  it('passes over an Authorization header of another scheme for the cookie, as a browser behind Basic auth sends', () => {
    const credential = connectionCredential(handshake({}, { authorization: 'Basic dXNlcjpwYXNz', cookie: COOKIE }));

    expect(credential).toEqual({ channel: 'cookie', headers: { cookie: COOKIE } });
  });

  it('is absent for cookies that hold no session cookie', () => {
    expect(connectionCredential(handshake({}, { cookie: 'theme=dark; lb=2' }))).toBeUndefined();
  });

  it.each([
    ['a line break', 'token\r\nx-injected: 1'],
    ['a space', 'two words'],
    ['a character no header can carry', 'tok\u{1F511}en'],
  ])('leaves a token holding %s nothing to look up, rather than passing it over for the cookie', (_, token) => {
    expect(connectionCredential(handshake({ token }, { cookie: COOKIE }))).toEqual({ channel: 'token', headers: {} });
  });

  it('is absent when the handshake carries none of the three', () => {
    expect(connectionCredential(handshake({}))).toBeUndefined();
  });

  it('is absent for a handshake with no `auth` at all', () => {
    expect(connectionCredential({ auth: undefined, headers: {} } as unknown as Socket['handshake'])).toBeUndefined();
  });
});

describe('WsSessionGuard', () => {
  const contextFor = (client: Partial<Socket>) =>
    ({ switchToWs: () => ({ getClient: () => client }) }) as unknown as ExecutionContext;

  const authServiceWith = (valid: boolean) => {
    const getSessionFromHeaders = jest.fn().mockResolvedValue(valid ? { session: {}, user: {} } : null);
    const authService = { getSessionFromHeaders, isValidSession: () => valid } as unknown as AuthService;

    return { authService, getSessionFromHeaders };
  };

  it("lets a frame through while its connection's credential still names a live session", async () => {
    const { authService, getSessionFromHeaders } = authServiceWith(true);
    const client = { handshake: handshake({ token: 'the-token' }, { cookie: COOKIE }) } as unknown as Socket;

    await expect(new WsSessionGuard(authService).canActivate(contextFor(client))).resolves.toBe(true);
    expect(getSessionFromHeaders).toHaveBeenCalledWith({ authorization: 'Bearer the-token' });
  });

  it("refuses a frame once its connection's session has ended, with the handshake's copy", async () => {
    const { authService } = authServiceWith(false);
    const client = { handshake: handshake({ token: 'the-token' }) } as unknown as Socket;

    const refusal = await new WsSessionGuard(authService).canActivate(contextFor(client)).catch((error) => error);

    expect(refusal).toBeInstanceOf(UnauthorizedException);
    const body = refusal.getResponse();
    expect(isI18nMessage(body) && body.key).toBe('errors.auth.session_invalid');
  });

  it('refuses a frame whose handshake carries no credential, without looking anything up', async () => {
    const { authService, getSessionFromHeaders } = authServiceWith(true);
    const client = { handshake: handshake({}) } as unknown as Socket;

    await expect(new WsSessionGuard(authService).canActivate(contextFor(client))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(getSessionFromHeaders).not.toHaveBeenCalled();
  });
});
