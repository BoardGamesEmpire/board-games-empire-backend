'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createClientState } = require('./client-state');

const FINGERPRINT = 'a'.repeat(64);

describe('prisma-generate client state', () => {
  let workspaceRoot;
  let outputDir;
  let client;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bge-state-'));
    outputDir = path.join(workspaceRoot, 'libs', 'database', 'src', 'lib', 'generated');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, 'node_modules', '.cache', 'prisma-generate'), { recursive: true });
    client = createClientState(workspaceRoot);
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  /** A complete generated tree: `client.ts` plus however many more files. */
  function writeGeneratedTree(fileCount) {
    fs.writeFileSync(path.join(outputDir, 'client.ts'), 'export {};');
    fs.writeFileSync(path.join(outputDir, 'migrations-manifest.ts'), 'export const MIGRATION_NAMES = [];');
    for (let i = 1; i <= fileCount - 2; i++) {
      fs.writeFileSync(path.join(outputDir, `file-${i}.ts`), 'export {};');
    }
  }

  /** The inputs `fingerprint()` reads: a schema file, the config, and a migrations tree. */
  function writeSchemaInputs() {
    fs.mkdirSync(path.join(workspaceRoot, 'prisma', 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" }');
    fs.writeFileSync(path.join(workspaceRoot, 'prisma.config.ts'), 'export default {};');
  }

  function addMigration(name) {
    const dir = path.join(workspaceRoot, 'prisma', 'migrations', name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'migration.sql'), `-- ${name}`);
  }

  it('is not current before anything has been stamped', () => {
    writeGeneratedTree(3);

    expect(client.isCurrent(FINGERPRINT)).toBe(false);
  });

  it('is current once a matching tree has been stamped', () => {
    writeGeneratedTree(3);
    client.writeStamp(FINGERPRINT);

    expect(client.isCurrent(FINGERPRINT)).toBe(true);
  });

  it('is not current for a different fingerprint', () => {
    writeGeneratedTree(3);
    client.writeStamp(FINGERPRINT);

    expect(client.isCurrent('b'.repeat(64))).toBe(false);
  });

  it('is not current when the tree no longer has the recorded file count', () => {
    writeGeneratedTree(3);
    client.writeStamp(FINGERPRINT);
    fs.rmSync(path.join(outputDir, 'file-1.ts'));

    expect(client.isCurrent(FINGERPRINT)).toBe(false);
  });

  it('stops reporting current once the stamp is cleared', () => {
    // The window this closes: a rebuild passes through a state that satisfies
    // the old stamp — same fingerprint, file count back up to the recorded
    // number, `client.ts` present — while the tree is still being written.
    writeGeneratedTree(3);
    client.writeStamp(FINGERPRINT);
    expect(client.isCurrent(FINGERPRINT)).toBe(true);

    client.clearStamp();

    expect(client.isCurrent(FINGERPRINT)).toBe(false);
  });

  it('reports the rebuilt tree as current even though it matches the cleared stamp', () => {
    writeGeneratedTree(3);
    client.writeStamp(FINGERPRINT);
    client.clearStamp();

    // Mid-rebuild: identical shape to what was stamped, but nothing vouches for it.
    expect(client.isCurrent(FINGERPRINT)).toBe(false);

    client.writeStamp(FINGERPRINT);

    expect(client.isCurrent(FINGERPRINT)).toBe(true);
  });

  it('tolerates clearing a stamp that is not there', () => {
    expect(() => client.clearStamp()).not.toThrow();
  });

  it('is not current when the migrations manifest is missing from an otherwise complete tree', () => {
    // The manifest is what lets the three CLI-less processes read their own
    // schema state (#236); a stamped tree without it is not the tree
    // this generate produces.
    writeGeneratedTree(3);
    client.writeStamp(FINGERPRINT);
    expect(client.isCurrent(FINGERPRINT)).toBe(true);

    // Swap the manifest for an unrelated file so the file COUNT still matches:
    // only an explicit check on the manifest can fail this.
    fs.rmSync(path.join(outputDir, 'migrations-manifest.ts'));
    fs.writeFileSync(path.join(outputDir, 'unrelated.ts'), 'export {};');

    expect(client.isCurrent(FINGERPRINT)).toBe(false);
  });

  describe('fingerprint', () => {
    it('changes when a migration is added even though no schema file changed', () => {
      // A SQL-only migration (a backfill, an index) touches no `.prisma` file.
      // Without this the manifest would go stale and api would boot believing
      // it is in sync with a migration still pending (#236).
      writeSchemaInputs();
      addMigration('20260109085042_init');
      const before = client.fingerprint();

      addMigration('20260910000000_backfill');

      expect(client.fingerprint()).not.toBe(before);
    });

    it("does not change when an applied migration's SQL is edited in place", () => {
      // Only migration NAMES feed the manifest and only `.prisma` feeds the
      // client; editing an existing migration's body (routine before alpha)
      // must not throw the generated tree away.
      writeSchemaInputs();
      addMigration('20260109085042_init');
      const before = client.fingerprint();

      fs.appendFileSync(
        path.join(workspaceRoot, 'prisma', 'migrations', '20260109085042_init', 'migration.sql'),
        '\n-- edited',
      );

      expect(client.fingerprint()).toBe(before);
    });

    it('is stable across calls when nothing changed', () => {
      writeSchemaInputs();
      addMigration('20260109085042_init');

      expect(client.fingerprint()).toBe(client.fingerprint());
    });
  });
});
