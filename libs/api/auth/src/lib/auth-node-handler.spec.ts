import { Logger } from '@nestjs/common';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAuthNodeHandler } from './auth-node-handler';
import { createAuthRequestHandler, type AuthRequestHandler } from './auth-request-handler';

/** The limit the adapter is built with here, small enough to cross in a few chunks. */
const LIMIT = 1024;

// Our own answer, in the api's error envelope (#1260).
const tooLarge = {
  statusCode: 413,
  error: 'Payload Too Large',
  code: 'REQUEST_TOO_LARGE',
  message: 'errors.auth.request_too_large',
};

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/**
 * `/api/auth/*` served through the adapter over a real socket (#1057), so a
 * body arrives as a client sends it: declared up front, or chunk by chunk.
 * Messages render as their catalog keys.
 */
describe('createAuthNodeHandler', () => {
  let server: Server;
  let port: number;

  async function serve(handler: AuthRequestHandler): Promise<void> {
    server = createServer(createAuthNodeHandler(handler, { maxBodyBytes: LIMIT, render: (key) => key }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  /**
   * Sends a request, lets `write` send its body, and resolves with the answer
   * as soon as it has arrived, whether or not the body was ended. A write the
   * server no longer reads may fail once it has answered, which is ignored.
   */
  function send(
    method: string,
    headers: Record<string, string | number>,
    write: (request: ReturnType<typeof httpRequest>) => void,
    { failOnError = false }: { failOnError?: boolean } = {},
  ): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, method, path: '/api/auth/sign-in/email', headers });
      request.on('error', failOnError ? reject : () => undefined);
      request.on('response', (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
          request.destroy();
        });
        response.on('error', reject);
      });
      write(request);
    });
  }

  /** Writes `total` bytes of JSON-ish filler in `size`-byte chunks. */
  function writeChunks(request: ReturnType<typeof httpRequest>, total: number, size: number): void {
    for (let sent = 0; sent < total; sent += size) {
      request.write('x'.repeat(Math.min(size, total - sent)));
    }
  }

  it('refuses a body that declares more than the limit, unread and without calling the route (#1057)', async () => {
    const handler = jest.fn<Promise<Response>, [Request]>();
    await serve(handler);

    const answer = await send('POST', { 'content-type': 'application/json', 'content-length': 10_000_000 }, (request) =>
      request.flushHeaders(),
    );

    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body)).toEqual(tooLarge);
    expect(answer.headers['content-type']).toMatch(/^application\/json/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps the connection for a body declaring more than the limit, so a client sending all of it reads the refusal (#1057)', async () => {
    // Closed, the server would reset a connection the client is still
    // writing to, and the reset can throw the refusal away unread.
    await serve(jest.fn<Promise<Response>, [Request]>());
    const total = 4 * 1024 * 1024;

    const answer = await send(
      'POST',
      { 'content-type': 'application/json', 'content-length': total },
      (request) => {
        writeChunks(request, total, 64 * 1024);
        request.end();
      },
      { failOnError: true },
    );

    expect(answer.status).toBe(413);
    expect(answer.headers.connection).not.toBe('close');
    expect(JSON.parse(answer.body)).toEqual(tooLarge);
  });

  it('refuses a chunked body as it grows past the limit, before it ends (#1057)', async () => {
    const read = jest.fn();
    await serve(async (request) => {
      read(await request.text());
      return new Response('read');
    });

    // The body is never ended, so an answer at all shows the adapter didn't
    // wait for the rest of it.
    const answer = await send(
      'POST',
      { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      (request) => writeChunks(request, LIMIT + 512, 256),
    );

    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body)).toEqual(tooLarge);
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a cut-off body even when the route catches the failed read itself (#1057)', async () => {
    // As app sign-in's token route can: it reads the body itself and answers
    // a body it can't read 400.
    const failedRead = jest.fn();
    await serve(async (request) => {
      try {
        await request.text();
      } catch {
        failedRead();
        return Response.json({ code: 'BAD_REQUEST' }, { status: 400 });
      }
      return new Response('read');
    });

    const answer = await send(
      'POST',
      { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      (request) => writeChunks(request, LIMIT + 512, 256),
    );

    expect(failedRead).toHaveBeenCalled();
    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body)).toEqual(tooLarge);
  });

  it.each<[string, Record<string, string | number>]>([
    ['declared', { 'content-length': LIMIT }],
    ['chunked', { 'transfer-encoding': 'chunked' }],
  ])('passes a %s body of exactly the limit to the route whole (#1057)', async (_, framing) => {
    await serve(async (request) => new Response(String((await request.arrayBuffer()).byteLength)));

    const answer = await send('POST', { 'content-type': 'application/json', ...framing }, (request) => {
      writeChunks(request, LIMIT, 256);
      request.end();
    });

    expect(answer.status).toBe(200);
    expect(answer.body).toBe(String(LIMIT));
  });

  it.each<[string, string, Record<string, string>]>([
    ['a GET', 'GET', { 'content-type': 'application/json' }],
    ['a POST with no content-type', 'POST', {}],
  ])("passes the route's answer for %s through, whatever size its unread body (#1057)", async (_, method, headers) => {
    // better-call reads neither body, so the route has already answered,
    // perhaps having used a token or cleared a session; a 413 saying nothing
    // was changed would be false, and would drop its cookies. The route takes
    // a moment, as one doing database work would, so the body arrives first.
    await serve(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const answered = new Headers();
      answered.append('set-cookie', 'bge.session_token=; Max-Age=0; Path=/');
      return new Response('done', { status: 200, headers: answered });
    });

    const answer = await send(method, { 'transfer-encoding': 'chunked', ...headers }, (request) => {
      writeChunks(request, LIMIT * 4, 256);
      request.end();
    });

    expect(answer.status).toBe(200);
    expect(answer.body).toBe('done');
    expect(answer.headers['set-cookie']).toEqual(['bge.session_token=; Max-Age=0; Path=/']);
  });

  it('keeps the answer of a route that answered before reading a body that then grew past the limit (#1057)', async () => {
    // As better-auth's router does for an unknown path: it answers 404 before
    // it reads the body. The body is sent only once the route has answered,
    // so the adapter has already checked the count when the bytes arrive. One
    // chunk past the limit is read and counted; a smaller first chunk would
    // leave the request paused unread (#1197), and nothing to count.
    let answered!: () => void;
    const routeAnswered = new Promise<void>((resolve) => (answered = resolve));
    await serve(async () => {
      answered();
      return new Response(null, { status: 404 });
    });

    const answer = await send(
      'POST',
      { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      (request) => {
        request.flushHeaders();
        void routeAnswered.then(() => request.end('x'.repeat(LIMIT * 4)));
      },
    );

    expect(answer.status).toBe(404);
  });

  it("answers a request whose URL can't be built 400 with a code, where Express answered an uncoded 500", async () => {
    const handler = jest.fn<Promise<Response>, [Request]>();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await serve(handler);

    const answer = await send('POST', { 'x-forwarded-proto': 'not a scheme' }, (request) => request.end());

    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body)).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: 'BAD_REQUEST',
      message: 'errors.auth.bad_request',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("doesn't log a cut-off body as a fault, through the api's handler (#1057)", async () => {
    // better-auth's parser fails on the cut-off read and rethrows to the
    // handler, which would log it at error level for anyone to set off.
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await serve(
      createAuthRequestHandler(
        async (request) => {
          await request.json();
          return new Response('read');
        },
        { render: (key) => key },
      ),
    );

    const answer = await send(
      'POST',
      { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      (request) => writeChunks(request, LIMIT + 512, 256),
    );

    expect(answer.status).toBe(413);
    expect(logged).not.toHaveBeenCalled();
  });

  it('passes a GET through with its headers and set-cookies (#1057)', async () => {
    await serve(async (request) => {
      const headers = new Headers({ 'x-seen-path': new URL(request.url).pathname });
      headers.append('set-cookie', 'first=1; Path=/');
      headers.append('set-cookie', 'second=2; Path=/; HttpOnly');
      return new Response('ok', { status: 200, headers });
    });

    const answer = await send('GET', {}, (request) => request.end());

    expect(answer.status).toBe(200);
    expect(answer.body).toBe('ok');
    expect(answer.headers['x-seen-path']).toBe('/api/auth/sign-in/email');
    expect(answer.headers['set-cookie']).toEqual(['first=1; Path=/', 'second=2; Path=/; HttpOnly']);
  });
});
