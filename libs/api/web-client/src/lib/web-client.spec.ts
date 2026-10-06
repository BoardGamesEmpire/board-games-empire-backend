import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import type { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import request from 'supertest';
import { createWebClient } from './web-client';

/** A Flutter web build in miniature: the files and folders the real one has. */
const BUILD: Record<string, string> = {
  'index.html':
    '<!DOCTYPE html><html><head><base href="/"></head><body><script src="flutter_bootstrap.js" async></script></body></html>',
  'flutter_bootstrap.js': '_flutter.loader.load();',
  'main.dart.js': 'main();',
  'drift_worker.js': 'onmessage = () => {};',
  'sqlite3.wasm': '\0asm sqlite',
  'canvaskit/canvaskit.wasm': '\0asm canvaskit',
  'assets/NOTICES': 'licenses',
  'assets/AssetManifest.bin': 'manifest',
  'version.json': '{"version":"1.0.0"}',
};

/** The api's routes that sit outside the client, as main.ts names them to Nest. */
const SERVER_ROUTES = ['api', 'metrics', 'health', 'health/*path', '.well-known/*path'];

const NAVIGATION = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/** File permissions don't stop root, so the unreadable-file cases can't run as root. */
const itUnlessRoot = process.getuid?.() === 0 ? it.skip : it;

async function writeBuild(root: string, files: Record<string, string> = BUILD): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

/** The api's middleware stack around the client, then the server's own routes, then a 404 like Nest's. */
async function serve(root: string): Promise<express.Express> {
  const webClient = await createWebClient({ root, serverRoutes: SERVER_ROUTES });
  const app = express();
  app.use(helmet());
  app.use(compression());
  if (webClient) app.use(webClient);
  app.get('/api/games', (_req, res) => res.json({ route: 'games' }));
  app.all('/api/auth/*any', (_req, res) => res.json({ route: 'auth' }));
  app.get('/health', (_req, res) => res.json({ route: 'health' }));
  app.get('/health/ready', (_req, res) => res.json({ route: 'ready' }));
  app.get('/metrics', (_req, res) => res.type('text/plain').send('metrics'));
  app.get('/.well-known/bge-identity', (_req, res) => res.json({ route: 'identity' }));
  app.use((req, res) => res.status(404).json({ statusCode: 404, message: `Cannot ${req.method} ${req.path}` }));
  return app;
}

describe('createWebClient', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bge-web-client-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('with no client bundled', () => {
    it('mounts nothing for an empty directory', async () => {
      expect(await createWebClient({ root, serverRoutes: SERVER_ROUTES })).toBeUndefined();
    });

    it('mounts nothing for a directory that does not exist', async () => {
      const missing = join(root, 'web');

      expect(await createWebClient({ root: missing, serverRoutes: SERVER_ROUTES })).toBeUndefined();
    });

    it('mounts nothing when the build has no index.html', async () => {
      const withoutIndex = Object.fromEntries(Object.entries(BUILD).filter(([path]) => path !== 'index.html'));
      await writeBuild(root, withoutIndex);

      expect(await createWebClient({ root, serverRoutes: SERVER_ROUTES })).toBeUndefined();
    });

    itUnlessRoot('refuses to start when index.html is there but cannot be read', async () => {
      await writeBuild(root);
      await chmod(join(root, 'index.html'), 0o000);

      await expect(createWebClient({ root, serverRoutes: SERVER_ROUTES })).rejects.toThrow(/EACCES/);
    });

    it('leaves a page navigation to / to the server, as before', async () => {
      const response = await request(await serve(root))
        .get('/')
        .set('Accept', NAVIGATION);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ statusCode: 404, message: 'Cannot GET /' });
    });
  });

  describe('with a client bundled', () => {
    let app: express.Express;

    beforeEach(async () => {
      await writeBuild(root);
      app = await serve(root);
    });

    it.each(['/', '/home', '/household/abc123/members'])(
      'answers a page navigation to %s with index.html',
      async (path) => {
        const response = await request(app).get(path).set('Accept', NAVIGATION);

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(response.text).toBe(BUILD['index.html']);
      },
    );

    it.each([
      ['/main.dart.js', 'text/javascript; charset=utf-8'],
      ['/drift_worker.js', 'text/javascript; charset=utf-8'],
      ['/sqlite3.wasm', 'application/wasm'],
      ['/canvaskit/canvaskit.wasm', 'application/wasm'],
      ['/version.json', 'application/json; charset=utf-8'],
      ['/assets/NOTICES', 'application/octet-stream'],
    ])('serves %s from the build as %s', async (path, contentType) => {
      const response = await request(app).get(path).set('Accept', '*/*').buffer(true).parse(asText);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe(contentType);
      expect(response.body).toBe(BUILD[path.slice(1)]);
    });

    it.each([
      ['/api/games', { route: 'games' }],
      ['/API/games', { route: 'games' }],
      ['/api/auth/get-session', { route: 'auth' }],
      ['/health', { route: 'health' }],
      ['/health/', { route: 'health' }],
      ['/health/ready', { route: 'ready' }],
      ['/.well-known/bge-identity', { route: 'identity' }],
      ['/api/no-such-route', { statusCode: 404, message: 'Cannot GET /api/no-such-route' }],
    ])('leaves a page navigation to %s to the server', async (path, body) => {
      const response = await request(app).get(path).set('Accept', NAVIGATION);

      expect(response.body).toEqual(body);
    });

    it.each([
      ['/missing.js', '*/*'],
      ['/assets/missing.png', 'image/avif,image/webp,*/*'],
      ['/canvaskit/missing.wasm', 'application/json, text/plain, */*'],
      ['/canvaskit', '*/*'],
      ['/home', 'text/html;q=0, */*'],
    ])('answers %s requested with Accept %j with the server 404', async (path, accept) => {
      const response = await request(app).get(path).set('Accept', accept);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ statusCode: 404, message: `Cannot GET ${path}` });
    });

    // A path the build lacks is the page to a browser and a 404 to everything
    // else, so a cache must key both answers on Accept.
    it('marks the page it answers a navigation with as varying by Accept', async () => {
      const response = await request(app).get('/home').set('Accept', NAVIGATION);

      expect(response.headers['vary']).toMatch(/\bAccept\b(?!-)/);
    });

    it('marks the 404 for a path the build lacks as varying by Accept', async () => {
      const response = await request(app).get('/home').set('Accept', '*/*');

      expect(response.status).toBe(404);
      expect(response.headers['vary']).toMatch(/\bAccept\b(?!-)/);
    });

    it('answers a HEAD page navigation like a GET, without the body', async () => {
      const response = await request(app).head('/home').set('Accept', NAVIGATION);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.text).toBeUndefined();
    });

    // The files have no modification date to compare, and RFC 9110 has a
    // server ignore the precondition then; send would fail it instead.
    it('serves a file to a request carrying If-Unmodified-Since', async () => {
      const response = await request(app)
        .get('/main.dart.js')
        .set('Accept', '*/*')
        .set('If-Unmodified-Since', 'Thu, 01 Jan 2015 00:00:00 GMT');

      expect(response.status).toBe(200);
      expect(response.text).toBe(BUILD['main.dart.js']);
    });

    itUnlessRoot('refuses to start when any file the build has cannot be read', async () => {
      await chmod(join(root, 'assets/NOTICES'), 0o000);

      await expect(createWebClient({ root, serverRoutes: SERVER_ROUTES })).rejects.toThrow(/EACCES/);
    });

    itUnlessRoot('reports a file the build has but cannot read as a server error, not as missing', async () => {
      await chmod(join(root, 'main.dart.js'), 0o000);

      const response = await request(app).get('/main.dart.js').set('Accept', NAVIGATION);

      expect(response.status).toBe(500);
    });

    it('answers a request with no Accept header for a missing file with the server 404', async () => {
      const response = await request(app).get('/missing.js').unset('Accept');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ statusCode: 404, message: 'Cannot GET /missing.js' });
    });

    describe('caching', () => {
      // Flutter names its files the same in every release, so nothing the client
      // serves may be cached without asking the server first.
      const everyPath = [...Object.keys(BUILD).map((path) => `/${path}`), '/'];

      it.each(everyPath)('makes the browser revalidate %s on every use', async (path) => {
        const response = await request(app).get(path).set('Accept', NAVIGATION);

        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-cache');
        expect(response.headers['etag']).toBeDefined();
        expect(response.headers['last-modified']).toBeUndefined();
      });

      it.each(['/main.dart.js', '/'])(
        'answers a revalidation of %s with 304 while its content is unchanged',
        async (path) => {
          const first = await request(app).get(path).set('Accept', NAVIGATION);
          const second = await request(app)
            .get(path)
            .set('Accept', NAVIGATION)
            .set('If-None-Match', first.headers['etag']);

          expect(second.status).toBe(304);
        },
      );

      it('gives index.html the same tag whether it is asked for by name or as a page', async () => {
        const byName = await request(app).get('/index.html').set('Accept', NAVIGATION);
        const asPage = await request(app).get('/household/abc123').set('Accept', NAVIGATION);

        expect(asPage.headers['etag']).toBe(byName.headers['etag']);
      });

      it('keeps the tag when a rebuild leaves the content alone and only the mtime moves', async () => {
        const before = await request(app).get('/version.json');
        await utimes(join(root, 'version.json'), new Date('2030-01-01'), new Date('2030-01-01'));
        const after = await request(await serve(root)).get('/version.json');

        expect(after.headers['etag']).toBe(before.headers['etag']);
      });

      it('changes the tag when the content changes but the size does not', async () => {
        const before = await request(app).get('/version.json');
        await writeFile(join(root, 'version.json'), '{"version":"1.0.1"}');
        const after = await request(await serve(root)).get('/version.json');

        expect(after.headers['etag']).not.toBe(before.headers['etag']);
      });

      it.each(everyPath)('serves %s whole, without ranges', async (path) => {
        const response = await request(app).get(path).set('Accept', NAVIGATION).set('Range', 'bytes=0-1');

        expect(response.status).toBe(200);
        expect(response.headers['accept-ranges']).toBeUndefined();
        expect(response.headers['content-range']).toBeUndefined();
      });
    });

    describe('content security policy', () => {
      /** helmet's default policy, as the api's own responses carry it. */
      const SERVER_POLICY = {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'font-src': ["'self'", 'https:', 'data:'],
        'form-action': ["'self'"],
        'frame-ancestors': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'object-src': ["'none'"],
        'script-src': ["'self'"],
        'script-src-attr': ["'none'"],
        'style-src': ["'self'", 'https:', "'unsafe-inline'"],
        'upgrade-insecure-requests': [],
      };

      // The client compiles WebAssembly (CanvasKit, and sqlite3 in its worker),
      // may be served over plain HTTP, and fetches fallback glyphs from Google Fonts.
      const CLIENT_POLICY = {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'font-src': ["'self'", 'https:', 'data:'],
        'form-action': ["'self'"],
        'frame-ancestors': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'object-src': ["'none'"],
        'script-src': ["'self'", "'wasm-unsafe-eval'"],
        'script-src-attr': ["'none'"],
        'style-src': ["'self'", 'https:', "'unsafe-inline'"],
        'connect-src': ["'self'", 'https://fonts.gstatic.com'],
      };

      it.each(['/', '/index.html', '/flutter_bootstrap.js', '/drift_worker.js', '/sqlite3.wasm'])(
        'gives %s the client policy',
        async (path) => {
          const response = await request(app).get(path).set('Accept', NAVIGATION);

          expect(parsePolicy(response.headers['content-security-policy'])).toEqual(CLIENT_POLICY);
        },
      );

      it.each(['/api/games', '/health', '/missing.js'])('leaves the server policy on %s', async (path) => {
        const response = await request(app).get(path).set('Accept', '*/*');

        expect(parsePolicy(response.headers['content-security-policy'])).toEqual(SERVER_POLICY);
      });
    });

    it('leaves a page navigation to /metrics to the server', async () => {
      const response = await request(app).get('/metrics').set('Accept', NAVIGATION);

      expect(response.text).toBe('metrics');
    });
  });
});

function parsePolicy(header: string): Record<string, string[]> {
  return Object.fromEntries(
    header.split(';').map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

/** Reads any response as text, whatever its type, so a file's bytes can be compared. */
function asText(
  res: EventEmitter & Pick<IncomingMessage, 'setEncoding'>,
  callback: (err: Error | null, body: string) => void,
): void {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (chunk: string) => (body += chunk));
  res.on('end', () => callback(null, body));
}
