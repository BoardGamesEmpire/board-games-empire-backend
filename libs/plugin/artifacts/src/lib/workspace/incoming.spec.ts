import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateIncoming } from './incoming';

describe('allocateIncoming (#1094)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bge-incoming-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const exists = async (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );

  it('refuses a .incoming that is a symbolic link (#1094)', async () => {
    // The sweep never follows a link, so scratch written through one would
    // never be cleared, and it may lie outside the plugins root.
    const root = join(dir, 'plugins');
    const elsewhere = join(dir, 'elsewhere');
    await mkdir(root);
    await mkdir(elsewhere);
    await symlink(elsewhere, join(root, '.incoming'));

    await expect(allocateIncoming(root)).rejects.toThrow('symbolic link');
  });

  it('allocates paths under .incoming without creating them, and cleans up (#1094)', async () => {
    const root = join(dir, 'plugins');

    const incoming = await allocateIncoming(root);

    expect(incoming.archivePath).toBe(join(root, '.incoming', `${incoming.id}.tgz`));
    expect(incoming.extractDir).toBe(join(root, '.incoming', incoming.id));
    expect(await exists(join(root, '.incoming'))).toBe(true);
    expect(await exists(incoming.archivePath)).toBe(false);
    expect(await exists(incoming.extractDir)).toBe(false);

    await writeFile(incoming.archivePath, 'x');
    await mkdir(incoming.extractDir);
    await incoming.cleanup();
    await incoming.cleanup();

    expect(await exists(incoming.archivePath)).toBe(false);
    expect(await exists(incoming.extractDir)).toBe(false);
  });
});
