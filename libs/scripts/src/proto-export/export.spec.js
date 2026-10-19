'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLock } = require('../prisma-generate/lock');
const { exportProtos } = require('./export');

const PROTOS = {
  'bge/gateway/v1/gateway.proto': 'syntax = "proto3";\npackage bge.gateway.v1;\n',
  'grpc/health/v1/health.proto': 'syntax = "proto3";\npackage grpc.health.v1;\n',
};

/** Writes `files` (relative path → contents) under `dir`, as `buf export -o dir` does. */
function writeFiles(dir, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/** A stand-in for buf: writes `files` into the directory it is given and exits with `status`. */
const exporter =
  (files, status = 0) =>
  (into) => {
    writeFiles(into, files);
    return status;
  };

/** Every file under `dir`, as relative path → contents. */
function readFiles(dir) {
  const files = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return files;
}

describe('exportProtos (#313)', () => {
  let root;
  let packageDir;
  let outputDir;
  let stagingRoot;
  let lockPath;

  /** One run of the export, with `runExport` standing in for buf. */
  const run = (runExport, lock = createLock({ lockPath, task: 'proto export' })) =>
    exportProtos({ outputDir, stagingRoot, runExport, lock });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bge-proto-export-'));
    packageDir = path.join(root, 'libs', 'proto', 'gateway');
    outputDir = path.join(packageDir, 'proto-export');
    stagingRoot = path.join(root, 'node_modules', '.cache', 'proto-export');
    lockPath = path.join(root, 'node_modules', '.cache', 'proto-export.lock.json');
    fs.mkdirSync(packageDir, { recursive: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes the export when there is none yet', () => {
    expect(run(exporter(PROTOS))).toEqual({ status: 0, written: true });
    expect(readFiles(outputDir)).toEqual(PROTOS);
  });

  // Under `npm start`, six Nx processes each run the export while the other
  // apps' webpack builds copy the directory.
  it('leaves an export that already matches untouched, so a build copying it never finds it part-written', () => {
    run(exporter(PROTOS));
    const before = fs.statSync(outputDir).ino;

    expect(run(exporter(PROTOS))).toEqual({ status: 0, written: false });
    expect(fs.statSync(outputDir).ino).toBe(before);
  });

  it('replaces an export whose files changed', () => {
    run(exporter(PROTOS));
    const changed = { ...PROTOS, 'bge/gateway/v1/gateway.proto': 'syntax = "proto3";\npackage bge.gateway.v2;\n' };

    expect(run(exporter(changed))).toEqual({ status: 0, written: true });
    expect(readFiles(outputDir)).toEqual(changed);
  });

  it('drops a .proto the sources no longer have, which exporting over the old files would keep', () => {
    run(exporter({ ...PROTOS, 'bge/gateway/v1/removed.proto': 'syntax = "proto3";\n' }));

    expect(run(exporter(PROTOS))).toEqual({ status: 0, written: true });
    expect(readFiles(outputDir)).toEqual(PROTOS);
  });

  it('keeps the export it has when buf fails, and returns buf’s status', () => {
    run(exporter(PROTOS));

    expect(run(exporter({ 'partial.proto': '' }, 1))).toEqual({ status: 1, written: false });
    expect(readFiles(outputDir)).toEqual(PROTOS);
  });

  // Staged beside the export, a run's directory appeared in proto-gateway and
  // vanished again under `eslint .`, which then failed on ENOENT.
  it('stages where nothing walking the package can find it', () => {
    const runExport = (into) => {
      expect(path.dirname(into)).toBe(stagingRoot);
      expect(fs.readdirSync(packageDir)).toEqual([]);
      return exporter(PROTOS)(into);
    };

    expect(run(runExport)).toEqual({ status: 0, written: true });
    expect(fs.readdirSync(packageDir)).toEqual(['proto-export']);
  });

  it('leaves nothing staged, whether buf succeeds or cannot be started', () => {
    const notFound = () => {
      throw Object.assign(new Error('spawnSync buf ENOENT'), { code: 'ENOENT' });
    };
    expect(() => run(notFound)).toThrow('spawnSync buf ENOENT');
    expect(fs.readdirSync(stagingRoot)).toEqual([]);

    run(exporter(PROTOS));
    expect(fs.readdirSync(stagingRoot)).toEqual([]);
  });

  it('writes nothing when another run moved the same export into place while this one exported', () => {
    let theirs;
    const runExport = (into) => {
      writeFiles(outputDir, PROTOS);
      theirs = fs.statSync(outputDir).ino;
      return exporter(PROTOS)(into);
    };

    expect(run(runExport)).toEqual({ status: 0, written: false });
    expect(fs.statSync(outputDir).ino).toBe(theirs);
  });

  it('settles on the same export another run moved in between its delete and its rename', () => {
    const rename = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementationOnce((from, to) => {
      writeFiles(to, PROTOS);
      return rename(from, to);
    });

    expect(run(exporter(PROTOS))).toEqual({ status: 0, written: false });
    expect(readFiles(outputDir)).toEqual(PROTOS);
    expect(fs.readdirSync(stagingRoot)).toEqual([]);
  });

  // Compared before the other run moved its files in, this run deleted them,
  // perhaps while that run's build was copying them.
  it('compares only once it holds the lock, so it writes nothing when another run moved the same export in while it waited', () => {
    const lock = createLock({ lockPath, task: 'proto export' });
    let theirs;
    const waiting = {
      acquire: () => {
        run(exporter(PROTOS));
        theirs = fs.statSync(outputDir).ino;
        lock.acquire();
      },
      release: () => lock.release(),
    };

    expect(run(exporter(PROTOS), waiting)).toEqual({ status: 0, written: false });
    expect(fs.statSync(outputDir).ino).toBe(theirs);
  });

  it('runs buf without the lock, so the exports run side by side', () => {
    const runExport = (into) => {
      expect(fs.existsSync(lockPath)).toBe(false);
      return exporter(PROTOS)(into);
    };

    run(runExport);
  });

  it('releases the lock whether the move succeeds or fails', () => {
    run(exporter(PROTOS));
    expect(fs.existsSync(lockPath)).toBe(false);

    jest.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    expect(() => run(exporter({ 'changed.proto': '' }))).toThrow('EACCES');
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
