import { extractPluginArchive } from '@boardgamesempire/plugin-analysis';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { Header } from 'tar-stream';
import { extract } from 'tar-stream';
import type { ArtifactEntry } from '../stage/artifact-entries.js';
import { listArtifactEntries } from '../stage/artifact-entries.js';
import { ToolkitError } from '../toolkit.errors.js';
import { packArtifact } from './pack-artifact.js';

const TOP_LEVEL = 'demo-sink-1.2.0';
const MTIME = 1_700_000_000;

/** A name past the 100 bytes a plain tar header holds, so the entry needs a pax header (#1093). */
const LONG_NAME = `${'a'.repeat(120)}.txt`;

/** The plugin's files, by path, including an empty one and names a plain tar header can't hold. */
const FILES: Readonly<Record<string, string>> = {
  'dist/empty.js': '',
  'dist/index.js': 'export const activate = () => undefined;\n',
  'manifest.json': '{"slug":"demo-sink","version":"1.2.0"}\n',
  'package.json': '{"name":"demo-sink","version":"1.2.0"}\n',
  [`assets/${LONG_NAME}`]: 'a long name\n',
  'assets/dé.txt': 'a name past ASCII\n',
};

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Every header in a gzip-compressed tar, read with tar-stream, in archive order. */
const readHeaders = async (file: string): Promise<Header[]> => {
  const tar = extract();
  const headers: Header[] = [];
  const reading = pipeline(createReadStream(file), createGunzip(), tar);

  for await (const entry of tar) {
    headers.push(entry.header);
    entry.resume();
  }

  await reading;

  return headers;
};

/** Every file under `dir`, by path relative to it, with its text. */
const readTree = async (dir: string): Promise<Record<string, string>> => {
  const tree: Record<string, string> = {};

  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      tree[
        path
          .slice(dir.length + 1)
          .split('\\')
          .join('/')
      ] = await readFile(path, 'utf8');
    }
  }

  return tree;
};

describe('packArtifact (#1093)', () => {
  let root: string;
  let entries: readonly ArtifactEntry[];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bge-pack-artifact-spec-'));
    const stageDir = join(root, 'stage');

    for (const [path, content] of Object.entries(FILES)) {
      await mkdir(dirname(join(stageDir, path)), { recursive: true });
      await writeFile(join(stageDir, path), content);
    }

    entries = await listArtifactEntries(stageDir, TOP_LEVEL);
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const outFileIn = async (name: string): Promise<string> => join(await mkdtemp(join(root, 'out-')), `${name}.tgz`);

  it("writes a plugin artifact the server's own extractor unpacks to the same files", async () => {
    const outFile = await outFileIn(TOP_LEVEL);

    const result = await packArtifact(entries, outFile, MTIME);

    const bytes = await readFile(outFile);
    expect(result).toEqual({ sha256: sha256(bytes), size: bytes.length });

    const intoDir = join(root, 'extracted');
    await extractPluginArchive(outFile, intoDir);
    expect(await readTree(intoDir)).toEqual(FILES);
    expect(existsSync(`${outFile}.partial`)).toBe(false);
  });

  it('gives every entry, in sorted order, the fixed mtime, owner and modes', async () => {
    const outFile = await outFileIn(TOP_LEVEL);

    await packArtifact(entries, outFile, MTIME);

    const headers = await readHeaders(outFile);
    expect(headers.map((header) => header.name)).toEqual(entries.map((entry) => entry.archiveName));

    for (const header of headers) {
      expect({
        gid: header.gid,
        gname: header.gname,
        mode: header.mode,
        mtime: header.mtime.getTime() / 1000,
        uid: header.uid,
        uname: header.uname,
      }).toEqual({
        gid: 0,
        gname: '',
        mode: header.type === 'directory' ? 0o755 : 0o644,
        mtime: MTIME,
        uid: 0,
        uname: '',
      });
    }
  });

  it('writes a gzip header that records no time and no operating system, so any machine writes the same bytes', async () => {
    const outFile = await outFileIn(TOP_LEVEL);

    await packArtifact(entries, outFile, 0);

    const head = (await readFile(outFile)).subarray(0, 10);
    // Bytes 4-7 are the gzip header's mtime; byte 9 names the operating
    // system, 255 for unknown (RFC 1952).
    expect([...head.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
    expect(head[9]).toBe(255);
  });

  it('writes the same bytes, and so the same checksum, every time it packs the same entries', async () => {
    const first = await outFileIn('first');
    const second = await outFileIn('second');

    const firstResult = await packArtifact(entries, first, MTIME);
    const secondResult = await packArtifact(entries, second, MTIME);

    expect(secondResult.sha256).toBe(firstResult.sha256);
    expect((await readFile(second)).equals(await readFile(first))).toBe(true);
  });

  it('refuses a plugin artifact larger than the limit as ARTIFACT_TOO_LARGE, and leaves no file behind', async () => {
    const outFile = await outFileIn(TOP_LEVEL);

    const failure = await packArtifact(entries, outFile, MTIME, 10).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ToolkitError);
    expect(failure).toMatchObject({ code: 'ARTIFACT_TOO_LARGE' });
    expect(await readdir(dirname(outFile))).toEqual([]);
  });

  it('leaves no file behind when a file to pack cannot be read', async () => {
    const outFile = await outFileIn(TOP_LEVEL);
    const missing: ArtifactEntry = {
      absolutePath: join(root, 'no-such-file.js'),
      archiveName: `${TOP_LEVEL}/no-such-file.js`,
      size: 1,
      type: 'file',
    };

    await expect(packArtifact([...entries, missing], outFile, MTIME)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(dirname(outFile))).toEqual([]);
  });
});
