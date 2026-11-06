'use strict';
const { spawnSync } = require('node:child_process');
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

  /** A complete generated tree: `client.ts`, the two files written beside it, and however many more. */
  function writeGeneratedTree(fileCount) {
    fs.writeFileSync(path.join(outputDir, 'client.ts'), 'export {};');
    fs.writeFileSync(path.join(outputDir, 'migrations-manifest.ts'), 'export const MIGRATION_NAMES = [];');
    fs.writeFileSync(path.join(outputDir, 'unit-id-columns.ts'), 'export const UNIT_ID_COLUMNS = {};');
    for (let i = 1; i <= fileCount - 3; i++) {
      fs.writeFileSync(path.join(outputDir, `file-${i}.ts`), 'export {};');
    }
  }

  function writeGeneratorFile(relativePath, content) {
    const file = path.join(workspaceRoot, 'libs', 'scripts', 'src', relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  /** The inputs `fingerprint()` reads: a schema file, the config, a migrations tree and the generator scripts. */
  function writeSchemaInputs() {
    fs.mkdirSync(path.join(workspaceRoot, 'prisma', 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" }');
    fs.writeFileSync(path.join(workspaceRoot, 'prisma.config.ts'), 'export default {};');
    writeGeneratorFile('prisma-generate/unit-id-columns.js', '// v1');
    writeGeneratorFile('prisma-generate/unit-id-columns.spec.js', '// spec v1');
    writeGeneratorFile('bin/prisma-generate.js', '// bin v1');
  }

  function addMigration(name) {
    const dir = path.join(workspaceRoot, 'prisma', 'migrations', name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'migration.sql'), `-- ${name}`);
  }

  it('is not current before anything has been stamped', () => {
    writeGeneratedTree(4);

    expect(client.isCurrent(FINGERPRINT)).toBe(false);
  });

  it('is current once a matching tree has been stamped', () => {
    writeGeneratedTree(4);
    client.writeStamp(FINGERPRINT);

    expect(client.isCurrent(FINGERPRINT)).toBe(true);
  });

  it('is not current for a different fingerprint', () => {
    writeGeneratedTree(4);
    client.writeStamp(FINGERPRINT);

    expect(client.isCurrent('b'.repeat(64))).toBe(false);
  });

  it('is not current when the tree no longer has the recorded file count', () => {
    writeGeneratedTree(4);
    client.writeStamp(FINGERPRINT);
    fs.rmSync(path.join(outputDir, 'file-1.ts'));

    expect(client.isCurrent(FINGERPRINT)).toBe(false);
  });

  it('stops reporting current once the stamp is cleared', () => {
    // The window this closes: a rebuild passes through a state that satisfies
    // the old stamp — same fingerprint, file count back up to the recorded
    // number, `client.ts` present — while the tree is still being written.
    writeGeneratedTree(4);
    client.writeStamp(FINGERPRINT);
    expect(client.isCurrent(FINGERPRINT)).toBe(true);

    client.clearStamp();

    expect(client.isCurrent(FINGERPRINT)).toBe(false);
  });

  it('reports the rebuilt tree as current even though it matches the cleared stamp', () => {
    writeGeneratedTree(4);
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
    writeGeneratedTree(4);
    client.writeStamp(FINGERPRINT);
    expect(client.isCurrent(FINGERPRINT)).toBe(true);

    // Swap the manifest for an unrelated file so the file COUNT still matches:
    // only an explicit check on the manifest can fail this.
    fs.rmSync(path.join(outputDir, 'migrations-manifest.ts'));
    fs.writeFileSync(path.join(outputDir, 'unrelated.ts'), 'export {};');

    expect(client.isCurrent(FINGERPRINT)).toBe(false);
  });

  it('is not current when unit-id-columns.ts is missing', () => {
    // The map of unit-id columns is part of what this generate produces
    // (#994), so a stamped tree without it is not current: generate must
    // write it, not report the client current without it.
    writeGeneratedTree(4);
    client.writeStamp(FINGERPRINT);
    expect(client.isCurrent(FINGERPRINT)).toBe(true);

    // Swap the map for an unrelated file so the file COUNT still matches:
    // only an explicit check on the map can fail this.
    fs.rmSync(path.join(outputDir, 'unit-id-columns.ts'));
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

    describe('the generator scripts', () => {
      // The unit-id columns are derived by code, not copied from the schema, so
      // an edit to that code must rebuild them. Otherwise a dev checkout keeps
      // the map the old code wrote, and the database tests replay against it
      // (#994).
      beforeEach(() => {
        writeSchemaInputs();
        addMigration('20260109085042_init');
      });

      it.each(['prisma-generate/unit-id-columns.js', 'bin/prisma-generate.js'])(
        'change the fingerprint when %s changes',
        (relativePath) => {
          const before = client.fingerprint();

          writeGeneratorFile(relativePath, '// v2');

          expect(client.fingerprint()).not.toBe(before);
        },
      );

      it('leave the fingerprint alone when only a spec changes', () => {
        const before = client.fingerprint();

        writeGeneratorFile('prisma-generate/unit-id-columns.spec.js', '// spec v2');

        expect(client.fingerprint()).toBe(before);
      });

      it('throw when the generate bin is missing, rather than leave it out of the hash', () => {
        // A moved bin would otherwise stop rebuilding the map without a word (#994).
        fs.rmSync(path.join(workspaceRoot, 'libs', 'scripts', 'src', 'bin', 'prisma-generate.js'));

        expect(() => client.fingerprint()).toThrow(/ENOENT/);
      });
    });

    it('reads the package versions under plain Node, as the generate bin runs it', () => {
      // Jest resolves packages its own way: it read prisma's entry point where
      // Node, following prisma's exports map, finds a file the package does not
      // ship. Only a real Node process shows what the bin will do (#994).
      writeSchemaInputs();
      addMigration('20260109085042_init');
      const script = `process.stdout.write(require(${JSON.stringify(require.resolve('./client-state'))}).createClientState(${JSON.stringify(workspaceRoot)}).fingerprint())`;

      const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });

      // A warning Node prints on stderr is not a failure; the exit status is.
      expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 0, stdout: client.fingerprint() });
    });

    it('is stable across calls when nothing changed', () => {
      writeSchemaInputs();
      addMigration('20260109085042_init');

      expect(client.fingerprint()).toBe(client.fingerprint());
    });
  });
});
