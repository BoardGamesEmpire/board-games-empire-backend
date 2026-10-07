import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { contentSecurityPolicy } from 'helmet';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import serveStatic from 'serve-static';

/**
 * The client's policy: helmet's default, which the api's own responses keep,
 * with three changes.
 *
 * - `'wasm-unsafe-eval'`: CanvasKit compiles WebAssembly, and so does the
 *   database worker for `sqlite3.wasm`.
 * - No `upgrade-insecure-requests`: it would send a plain-HTTP self-hosted
 *   instance's page to fetch its own files over HTTPS.
 * - `fonts.gstatic.com` in `connect-src`: Flutter fetches the fonts for glyphs
 *   its bundled fonts lack (emoji, CJK) from there.
 *
 * Every file gets it, not only `index.html`, because a worker takes its policy
 * from its own script's response.
 */
const clientPolicy = contentSecurityPolicy({
  directives: {
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'connect-src': ["'self'", 'https://fonts.gstatic.com'],
    'upgrade-insecure-requests': null,
  },
});

export interface WebClientOptions {
  /** The directory holding the client's built files. */
  root: string;
  /** The server's own routes, as the api names them to Nest. The client never answers under them. */
  serverRoutes: readonly string[];
}

/**
 * Serves the bundled web client, or returns `undefined` when there is none to
 * serve: the client is present when its `index.html` is (#598).
 */
export async function createWebClient(options: WebClientOptions): Promise<RequestHandler | undefined> {
  const root = resolve(options.root);
  const indexPath = join(root, 'index.html');
  const index = await readFile(indexPath).catch((error: NodeJS.ErrnoException) => {
    // Only an absent client means there is none to serve. One that is there
    // but unreadable is a broken image, and the api should not start on it.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  });
  if (!index) return undefined;

  const entityTags = await contentEntityTags(root);
  const isServerPath = serverPathMatcher(options.serverRoutes);
  const files = serveStatic(root, {
    index: false,
    redirect: false,
    // The validator is the content's hash, set below; send's own is built from
    // the size and mtime, and the image's mtimes are its build time.
    etag: false,
    lastModified: false,
    cacheControl: false,
    // The api compresses every response, and a compressed range would carry a
    // Content-Range counting uncompressed bytes.
    acceptRanges: false,
    setHeaders: (res, path) => setClientHeaders(res, entityTags.get(path)),
  });

  return (req: Request, res: Response, next: NextFunction) => {
    if (isServerPath(req.path)) return next();

    // The files are served without a modification date, and RFC 9110 has a
    // server ignore If-Unmodified-Since then. send fails the precondition
    // instead, which would turn a file the build has into a miss.
    delete req.headers['if-unmodified-since'];

    files(req, res, (error?: unknown) => {
      // A failure to read a file the build has is the server's error, not a
      // miss: serve-static passes those on and treats only the rest as absent.
      if (error) return next(error);
      // A path the build lacks is the page to a browser and a 404 to anything
      // else, so the answer depends on Accept either way.
      res.vary('Accept');
      if (!isPageNavigation(req)) return next();
      setClientHeaders(res, entityTags.get(indexPath));
      res.type('html').send(index);
    });
  };
}

/**
 * The headers on everything the client serves. Flutter names its files the
 * same in every release, so every response asks the browser to revalidate, and
 * the validator is the file's content.
 */
function setClientHeaders(res: ServerResponse, entityTag: string | undefined): void {
  res.setHeader('Cache-Control', 'no-cache');
  if (entityTag) res.setHeader('ETag', entityTag);
  clientPolicy(res.req, res, () => undefined);
}

/**
 * Hashes every file once, by its absolute path. The files ship inside the
 * image and can't change while the process runs. They are read all at once so
 * the reads overlap: one after another, they take several times as long.
 *
 * A file that can't be read stops the api, as an unreadable `index.html` does:
 * the image is broken, and a crash at boot says so where a 500 on one file
 * would not.
 *
 * The tags are weak because the api compresses responses on the way out, so
 * the bytes sent differ by encoding even when the file is the same.
 */
async function contentEntityTags(root: string): Promise<Map<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));

  return new Map(
    await Promise.all(
      files.map(async (path) => {
        const digest = createHash('sha256')
          .update(await readFile(path))
          .digest('base64url');
        return [path, `W/"${digest}"`] as const;
      }),
    ),
  );
}

/**
 * Whether a request is a browser loading a page, the only request a missing
 * path answers with `index.html`. It has to name `text/html` itself: a
 * wildcard is what scripts, `fetch` and Flutter's own asset loads send, and
 * they must see a missing file as missing. `Sec-Fetch-Mode` would be more
 * direct, but browsers send it only to secure origins, and a self-hosted
 * instance may be on plain HTTP.
 */
function isPageNavigation(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  return (req.headers.accept ?? '').split(',').some((range) => {
    const [type, ...params] = range.split(';').map((part) => part.trim().toLowerCase());
    return type === 'text/html' && !params.some((param) => /^q=0(\.0{0,3})?$/.test(param));
  });
}

/**
 * Whether a request path falls under one of the server's routes. A route owns
 * everything under its literal leading segments (`health/*path` owns
 * `/health`), and the comparison ignores case because Express routes that way.
 */
function serverPathMatcher(routes: readonly string[]): (path: string) => boolean {
  // A route listed once per method, as `.well-known/*path` is, owns one prefix.
  const prefixes = [
    ...new Set(
      routes.map((route) => {
        const literal: string[] = [];
        for (const segment of route.split('/').filter(Boolean)) {
          if (/[*:{(]/.test(segment)) break;
          literal.push(segment.toLowerCase());
        }
        return `/${literal.join('/')}`;
      }),
    ),
  ];

  return (path) => {
    const lower = path.toLowerCase();
    return prefixes.some((prefix) => prefix === '/' || lower === prefix || lower.startsWith(`${prefix}/`));
  };
}
