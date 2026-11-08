import { buildPluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placePluginArtifact } from './place-plugin-artifact';

describe('placePluginArtifact (#1094)', () => {
  let root: string;
  const sha256 = buildPluginArtifactSha256('a');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bge-place-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const extracted = async (name: string, content: string) => {
    const dir = join(root, '.incoming', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), content);
    return dir;
  };

  const exists = async (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );

  it('refuses a slug directory that is a symbolic link, and moves nothing through it (#1094)', async () => {
    // The loader refuses an artifact behind a linked slug directory, and the
    // sweep never follows a link, so one placed through it would sit outside
    // the root, unloadable and never swept.
    const elsewhere = await mkdtemp(join(tmpdir(), 'bge-place-elsewhere-'));
    try {
      await symlink(elsewhere, join(root, 'demo-sink'));
      const dir = await extracted('one', 'first');

      await expect(placePluginArtifact(dir, root, 'demo-sink', sha256)).rejects.toThrow('symbolic link');

      expect(await readdir(elsewhere)).toEqual([]);
      expect(await exists(dir)).toBe(true);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('places an extracted artifact at <root>/<slug>/<sha256> (#1094)', async () => {
    const dir = await extracted('one', 'first');

    await expect(placePluginArtifact(dir, root, 'demo-sink', sha256)).resolves.toBe('placed');

    expect(await readFile(join(root, 'demo-sink', sha256, 'manifest.json'), 'utf8')).toBe('first');
    expect(await exists(dir)).toBe(false);
  });

  it('places once and discards a second identical copy (#1094)', async () => {
    const first = await extracted('one', 'same');
    const second = await extracted('two', 'same');

    const answers = await Promise.all([
      placePluginArtifact(first, root, 'demo-sink', sha256),
      placePluginArtifact(second, root, 'demo-sink', sha256),
    ]);

    expect([...answers].sort()).toEqual(['already-present', 'placed']);
    const loser = answers[0] === 'already-present' ? first : second;
    expect(await exists(loser)).toBe(false);
    expect(await readFile(join(root, 'demo-sink', sha256, 'manifest.json'), 'utf8')).toBe('same');
  });

  it('touches an already-present directory so the sweep spares it (#1094)', async () => {
    await placePluginArtifact(await extracted('one', 'same'), root, 'demo-sink', sha256);
    const target = join(root, 'demo-sink', sha256);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(target, twoHoursAgo, twoHoursAgo);

    await expect(placePluginArtifact(await extracted('two', 'same'), root, 'demo-sink', sha256)).resolves.toBe(
      'already-present',
    );

    expect(Date.now() - (await stat(target)).mtimeMs).toBeLessThan(60_000);
  });

  it('keeps different checksums of one slug side by side (#1094)', async () => {
    await placePluginArtifact(await extracted('one', 'a'), root, 'demo-sink', sha256);

    await expect(
      placePluginArtifact(await extracted('two', 'b'), root, 'demo-sink', buildPluginArtifactSha256('b')),
    ).resolves.toBe('placed');
  });

  it.each(['..', '../x', 'a/b', '', 'UPPER'])(
    'throws for the slug %j instead of leaving the root (#1094)',
    async (slug) => {
      const dir = await extracted('one', 'a');

      await expect(placePluginArtifact(dir, root, slug, sha256)).rejects.toThrow('not a plugin slug');
      expect(await exists(dir)).toBe(true);
    },
  );
});
