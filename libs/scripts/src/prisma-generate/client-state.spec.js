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
    for (let i = 1; i < fileCount; i++) {
      fs.writeFileSync(path.join(outputDir, `file-${i}.ts`), 'export {};');
    }
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
});
