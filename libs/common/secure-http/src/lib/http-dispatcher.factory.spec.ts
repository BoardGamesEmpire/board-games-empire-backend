import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request, type Dispatcher } from 'undici';
import { HttpDispatcherFactory } from './http-dispatcher.factory';

describe('HttpDispatcherFactory', () => {
  let server: Server | undefined;
  let dispatcher: Dispatcher | undefined;

  afterEach(async () => {
    await dispatcher?.close();
    dispatcher = undefined;

    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server = undefined;
    });
  });

  it("connects to the pinned address under Node's default autoSelectFamily (#1094)", async () => {
    server = createServer((_req, res) => {
      res.statusCode = 200;
      res.end('pinned');
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    dispatcher = new HttpDispatcherFactory().build('127.0.0.1', 4, 5_000);

    // `.test` is reserved and never resolves: a 200 here proves the name never
    // reached DNS and the connection went to the pinned address.
    const response = await request(`http://pinned.example.test:${port}/`, { dispatcher });

    expect(response.statusCode).toBe(200);
    await expect(response.body.text()).resolves.toBe('pinned');
  });
});
