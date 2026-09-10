import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLineForwarder, createPrismaCliMigrator, findPrismaProjectRoot } from './prisma-cli-migrator';

// The CLI must run where `prisma.config.ts` is: the workspace root under
// `nx serve`, `/app` in the container. The search is pure so the
// order and the failure message are pinned here; spawning is e2e's.

describe('findPrismaProjectRoot', () => {
  const exists = (present: readonly string[]) => (candidate: string) => present.includes(candidate);

  it('prefers the working directory when it holds prisma.config.ts', () => {
    expect(findPrismaProjectRoot(['/work', '/app'], exists(['/work/prisma.config.ts', '/app/prisma.config.ts']))).toBe(
      '/work',
    );
  });

  it('falls back to the bundle directory when the working directory has no config', () => {
    expect(findPrismaProjectRoot(['/somewhere', '/app'], exists(['/app/prisma.config.ts']))).toBe('/app');
  });

  it('skips empty candidates and names every place it looked when none has the config', () => {
    expect(() => findPrismaProjectRoot(['/somewhere', '', '/app'], exists([]))).toThrow(
      /prisma\.config\.ts.*\/somewhere.*\/app/s,
    );
  });
});

describe('createPrismaCliMigrator', () => {
  it('constructs without the CLI, warns that it cannot apply, and fails only when asked to apply', async () => {
    // An in-sync database must boot even from an image whose prisma assets are
    // missing; the defect is logged at once and refuses only a pending migration.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bge-no-prisma-'));
    const warnings: string[] = [];
    const logger = { log: () => undefined, warn: (message: string) => void warnings.push(message) };

    try {
      const migrator = createPrismaCliMigrator({ databaseUrl: 'postgres://unused', logger, projectRoot: root });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/cannot apply migrations/);
      await expect(migrator.apply(['20260109_init'])).rejects.toThrow(/prisma\/build\/index\.js/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createLineForwarder', () => {
  it('emits whole lines only, joining a line split across two chunks, and flushes the tail at end', () => {
    const lines: string[] = [];
    const forward = createLineForwarder((line) => void lines.push(line));

    forward.write(Buffer.from('Applying migration `2026'));
    forward.write(Buffer.from('0109_init`\n\nThe following'));
    expect(lines).toEqual(['Applying migration `20260109_init`']);

    forward.end();
    expect(lines).toEqual(['Applying migration `20260109_init`', 'The following']);
  });
});
