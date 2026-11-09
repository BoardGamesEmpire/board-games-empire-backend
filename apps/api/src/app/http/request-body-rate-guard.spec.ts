import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import {
  API_REQUEST_TIMEOUT_MS,
  installRequestBodyRateGuard,
  REQUEST_BODY_MIN_BYTES,
  REQUEST_BODY_WINDOW_MS,
} from './request-body-rate-guard';

// A small window keeps the suite fast. The timing margins are wide on purpose,
// so a runner three times slower than a laptop reaches the same outcomes:
//  - a closed connection is awaited by event (up to WAIT_MS), never by a fixed sleep;
//  - the steady sender writes 4 KiB every 20 ms, four times the 1 KiB floor even
//    if each 100 ms window held one chunk, and a chunk gap of three times
//    its interval (60 ms) still lands inside every window;
//  - the dribbler writes 10 bytes every 50 ms, a hundredth of the floor, so no
//    slowdown lifts it over the floor;
//  - the "left alone" cases hold for 4 windows, and a slower runner only holds
//    for longer in wall time, never fewer windows.
const WINDOW_MS = 100;
const MIN_BYTES = 1024;
const WAIT_MS = 5000;
const CHUNK = Buffer.alloc(4096, 'a');
const CHUNK_EVERY_MS = 20;

function postHead(length: number): string {
  return `POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: ${length}\r\n\r\n`;
}

describe('request body rate guard (#1094)', () => {
  let server: Server;
  let port: number;
  let readBody: boolean;
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();

  function handler(req: IncomingMessage, res: ServerResponse) {
    if (!readBody) {
      res.end('early');
      return;
    }

    req.on('data', () => undefined);
    req.on('end', () => res.end('ok'));
  }

  beforeEach(async () => {
    readBody = true;
    server = createServer(handler);
    installRequestBodyRateGuard(server, { windowMs: WINDOW_MS, minBytes: MIN_BYTES });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    timers.forEach((timer) => clearInterval(timer));
    timers.clear();
    sockets.forEach((socket) => socket.destroy());
    sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function client(): { socket: Socket; received: () => string; closed: Promise<void> } {
    const socket = connect(port, '127.0.0.1');
    sockets.add(socket);
    let text = '';
    socket.on('data', (chunk) => (text += chunk.toString()));
    socket.on('error', () => undefined);
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));

    return { socket, received: () => text, closed };
  }

  function every(ms: number, fn: () => void): void {
    timers.add(setInterval(fn, ms));
  }

  function stopTimers(): void {
    timers.forEach((timer) => clearInterval(timer));
    timers.clear();
  }

  // Resolves with whether the socket closed before `ms` passed.
  async function closesWithin(closed: Promise<void>, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout;
    const timedOut = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
    const result = await Promise.race([closed.then(() => true), timedOut]);
    clearTimeout(timer!);

    return result;
  }

  // Sends `chunks` chunks of CHUNK; resolves once the last one is written.
  function steady(socket: Socket, chunks: number): Promise<void> {
    return new Promise((resolve) => {
      let sent = 0;
      every(CHUNK_EVERY_MS, () => {
        if (socket.destroyed) {
          return resolve();
        }
        socket.write(CHUNK);
        if (++sent === chunks) {
          stopTimers();
          resolve();
        }
      });
    });
  }

  async function answered(received: () => string, count = 1): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      if (received().split('HTTP/1.1 200').length - 1 >= count) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('exports the values the api is configured with (#1094)', () => {
    expect(API_REQUEST_TIMEOUT_MS).toBe(60 * 60 * 1000);
    expect(REQUEST_BODY_MIN_BYTES).toBe(64 * 1024);
    expect(REQUEST_BODY_WINDOW_MS).toBe(60_000);
  });

  it('closes a connection whose body dribbles (#1094)', async () => {
    const { socket, closed } = client();
    socket.write(postHead(1_000_000));
    every(50, () => socket.write('0123456789'));

    expect(await closesWithin(closed, WAIT_MS)).toBe(true);
  });

  it('closes a connection whose body stops arriving altogether (#1094)', async () => {
    const { socket, closed } = client();
    socket.write(postHead(1_000_000) + 'partial');

    expect(await closesWithin(closed, WAIT_MS)).toBe(true);
  });

  it('lets a slow but steady body finish (#1094)', async () => {
    const { socket, received } = client();
    const chunks = 50;
    socket.write(postHead(CHUNK.length * chunks));
    await steady(socket, chunks);
    await answered(received);

    expect(received()).toContain('HTTP/1.1 200');
    expect(socket.destroyed).toBe(false);
  });

  it('leaves a request with no body alone (#1094)', async () => {
    const { socket, received, closed } = client();
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS * 4));

    expect(await closesWithin(closed, 0)).toBe(false);
    expect(received()).toContain('HTTP/1.1 200');
  });

  it('leaves a bodiless request alone even when its handler answers late (#1094)', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => setTimeout(() => res.end('late'), WINDOW_MS * 4));
    installRequestBodyRateGuard(server, { windowMs: WINDOW_MS, minBytes: MIN_BYTES });

    const { socket, received } = client();
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await answered(received);

    expect(received()).toContain('late');
  });

  it('keeps watching after an early answer, so a body that trickles in afterwards is cut off (#1094)', async () => {
    // As after a 401, 403 or 404 answered before the body was read: Node goes
    // on draining the body, and a client that trickles it would hold the
    // connection until the request timeout.
    readBody = false;
    const { socket, received, closed } = client();
    socket.write(postHead(1_000_000));
    every(50, () => socket.write('0123456789'));
    await answered(received);

    expect(received()).toContain('early');
    expect(await closesWithin(closed, WAIT_MS)).toBe(true);
  });

  it('lets a fast body finish after an early answer, and keeps the connection (#1094)', async () => {
    readBody = false;
    const { socket, received, closed } = client();
    const chunks = 30;
    socket.write(postHead(CHUNK.length * chunks));
    await steady(socket, chunks);
    await answered(received);

    expect(received()).toContain('early');
    expect(await closesWithin(closed, WINDOW_MS * 4)).toBe(false);
    expect(socket.destroyed).toBe(false);
  });

  it('does not count a window in which nothing read the body yet, as while authority is checked (#1094)', async () => {
    // A full-speed client: once the request's buffer fills, Node stops
    // reading the socket, which looks like a client that stopped sending.
    server.removeAllListeners('request');
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      setTimeout(() => {
        req.on('data', () => undefined);
        req.on('end', () => res.end('ok'));
      }, WINDOW_MS * 4);
    });
    installRequestBodyRateGuard(server, { windowMs: WINDOW_MS, minBytes: MIN_BYTES });

    const { socket, received } = client();
    const big = Buffer.alloc(2 * 1024 * 1024, 'c');
    socket.write(postHead(big.length));
    socket.write(big);
    await answered(received);

    expect(received()).toContain('HTTP/1.1 200');
    expect(socket.destroyed).toBe(false);
  });

  it('does not count a window in which a reader paused the body, as a slow disk does (#1094)', async () => {
    server.removeAllListeners('request');
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      req.once('data', () => {
        req.pause();
        setTimeout(() => req.resume(), WINDOW_MS * 4);
      });
      req.on('data', () => undefined);
      req.on('end', () => res.end('ok'));
    });
    installRequestBodyRateGuard(server, { windowMs: WINDOW_MS, minBytes: MIN_BYTES });

    const { socket, received } = client();
    const big = Buffer.alloc(2 * 1024 * 1024, 'd');
    socket.write(postHead(big.length));
    socket.write(big);
    await answered(received);

    expect(received()).toContain('HTTP/1.1 200');
    expect(socket.destroyed).toBe(false);
  });

  it('measures each keep-alive request on its own (#1094)', async () => {
    const { socket, received, closed } = client();

    // First request: a big body in one write, answered at once.
    const big = Buffer.alloc(256 * 1024, 'b');
    socket.write(postHead(big.length));
    socket.write(big);
    await answered(received, 1);

    // Second request, same connection: a steady body finishes.
    const chunks = 30;
    socket.write(postHead(CHUNK.length * chunks));
    await steady(socket, chunks);
    await answered(received, 2);
    expect(received().split('HTTP/1.1 200').length - 1).toBe(2);

    // Third request: it dribbles, and is cut off on its own count even though
    // the connection has carried hundreds of KiB.
    socket.write(postHead(1_000_000));
    every(50, () => socket.write('0123456789'));

    expect(await closesWithin(closed, WAIT_MS)).toBe(true);
  });
});

describe('request body rate guard baseline (#1094)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // Stubs only what the guard reads, so the first window is checked exactly.
  function stubRequest(socket: EventEmitter, server: EventEmitter) {
    // Read as it arrives, as by a handler that consumes the body.
    const req = Object.assign(new EventEmitter(), {
      socket,
      headers: { 'content-length': '1000000' },
      complete: false,
      readableFlowing: true,
      readableLength: 0,
    });
    server.emit('request', req, new EventEmitter());

    return req;
  }

  it('counts a keep-alive request from its own start, not from the connection (#1094)', () => {
    const server = new EventEmitter();
    installRequestBodyRateGuard(server as unknown as Server, { windowMs: 100, minBytes: 1024 });
    const socket = Object.assign(new EventEmitter(), { bytesRead: 0, destroy: jest.fn() });

    // An earlier request on this connection moved far more than the floor.
    const first = stubRequest(socket, server);
    socket.bytesRead = 256 * 1024;
    first.complete = true;
    first.emit('end');

    // The next request sends almost nothing.
    stubRequest(socket, server);
    socket.bytesRead += 10;
    jest.advanceTimersByTime(100);

    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not count a window in which the server began reading just before its end, then counts the next (#1094)', () => {
    const server = new EventEmitter();
    installRequestBodyRateGuard(server as unknown as Server, { windowMs: 100, minBytes: 1024 });
    const socket = Object.assign(new EventEmitter(), { bytesRead: 0, destroy: jest.fn() });

    // Nothing read the body for most of the window; reading starts a moment
    // before the check, too late for the socket to have been read again.
    const req = stubRequest(socket, server);
    jest.advanceTimersByTime(99);
    req.emit('resume');
    jest.advanceTimersByTime(1);

    expect(socket.destroy).not.toHaveBeenCalled();

    // A whole window of reading with almost nothing arriving is the client's.
    socket.bytesRead += 10;
    jest.advanceTimersByTime(100);

    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it('without options, checks 64 KiB a minute, the values the api runs with (#1094)', () => {
    const server = new EventEmitter();
    installRequestBodyRateGuard(server as unknown as Server);
    const socket = Object.assign(new EventEmitter(), { bytesRead: 0, destroy: jest.fn() });

    stubRequest(socket, server);
    socket.bytesRead += REQUEST_BODY_MIN_BYTES;
    jest.advanceTimersByTime(REQUEST_BODY_WINDOW_MS - 1);

    expect(socket.destroy).not.toHaveBeenCalled();

    // The first window had exactly the floor; the second has one byte less.
    jest.advanceTimersByTime(1);
    socket.bytesRead += REQUEST_BODY_MIN_BYTES - 1;
    jest.advanceTimersByTime(REQUEST_BODY_WINDOW_MS);

    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it('stops watching a body that has all arrived, though nothing has read it to its end yet (#1094)', () => {
    const server = new EventEmitter();
    installRequestBodyRateGuard(server as unknown as Server, { windowMs: 100, minBytes: 1024 });
    const socket = Object.assign(new EventEmitter(), { bytesRead: 0, destroy: jest.fn() });

    // The whole body is in, so no 'end' has fired and no more bytes come.
    const req = stubRequest(socket, server);
    req.complete = true;
    jest.advanceTimersByTime(100);

    expect(socket.destroy).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
