import type { PluginTarballEntry } from '@boardgamesempire/plugin-analysis';
import { buildPluginTarball, extractPluginArchive } from '@boardgamesempire/plugin-analysis';
import { PLUGIN_ARCHIVE_MAX_MANIFEST_BYTES } from '@boardgamesempire/plugin-manifest';
import * as fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readArtifactSlug } from './read-artifact-slug';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual('node:fs/promises');
  return { ...actual, readFile: jest.fn(actual.readFile) };
});

const VALID: PluginTarballEntry[] = [
  { name: 'package/manifest.json', content: JSON.stringify({ slug: 'demo-sink' }) },
  { name: 'package/package.json', content: '{}' },
];

describe('readArtifactSlug (#1094)', () => {
  let dir: string;
  let intoDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bge-slug-'));
    intoDir = join(dir, 'out');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the slug from an extracted manifest (#1094)', async () => {
    const archivePath = join(dir, 'a.tgz');
    await writeFile(archivePath, await buildPluginTarball(VALID));
    await extractPluginArchive(archivePath, intoDir);

    expect(await readArtifactSlug(intoDir)).toBe('demo-sink');
  });

  it.each([
    ['not JSON', 'nope'],
    ['not an object', '[]'],
    ['no slug', '{}'],
    ['a slug that is not a string', '{"slug": 5}'],
    ['a slug that fails the pattern', '{"slug": "../evil"}'],
  ])('refuses %s as manifest-slug (#1094)', async (_label, manifest) => {
    await mkdir(intoDir, { recursive: true });
    await writeFile(join(intoDir, 'manifest.json'), manifest);

    await expect(readArtifactSlug(intoDir)).rejects.toMatchObject({ rule: 'manifest-slug' });
  });

  it('reads a manifest of exactly the manifest cap and refuses one a byte over as manifest-size, the checker rule (#1094)', async () => {
    const manifestOf = (bytes: number): string => {
      const empty = JSON.stringify({ slug: 'demo-sink', pad: '' });
      return JSON.stringify({ slug: 'demo-sink', pad: 'x'.repeat(bytes - empty.length) });
    };

    await mkdir(intoDir, { recursive: true });

    await writeFile(join(intoDir, 'manifest.json'), manifestOf(PLUGIN_ARCHIVE_MAX_MANIFEST_BYTES));
    await expect(readArtifactSlug(intoDir)).resolves.toBe('demo-sink');

    await writeFile(join(intoDir, 'manifest.json'), manifestOf(PLUGIN_ARCHIVE_MAX_MANIFEST_BYTES + 1));
    await expect(readArtifactSlug(intoDir)).rejects.toMatchObject({ rule: 'manifest-size', entry: 'manifest.json' });
  });

  it('refuses a missing manifest as manifest-slug (#1094)', async () => {
    await mkdir(intoDir, { recursive: true });

    await expect(readArtifactSlug(intoDir)).rejects.toMatchObject({ rule: 'manifest-slug' });
  });

  it('refuses a manifest.json that is a directory as manifest-slug (#1094)', async () => {
    await mkdir(join(intoDir, 'manifest.json'), { recursive: true });

    await expect(readArtifactSlug(intoDir)).rejects.toMatchObject({ rule: 'manifest-slug' });
  });

  // A disk fault is the server's, not the archive's: it must not reach the
  // uploader as a refusal of their manifest.
  it.each(['EACCES', 'EIO'])('lets %s reading the manifest propagate as it is (#1094)', async (code) => {
    await mkdir(intoDir, { recursive: true });
    await writeFile(join(intoDir, 'manifest.json'), JSON.stringify({ slug: 'demo-sink' }));
    const failure = Object.assign(new Error(code), { code, syscall: 'open' });
    (fsPromises.readFile as unknown as jest.Mock).mockRejectedValueOnce(failure);

    await expect(readArtifactSlug(intoDir)).rejects.toBe(failure);
  });
});
