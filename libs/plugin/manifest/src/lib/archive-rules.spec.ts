import type { PluginArchiveEntry } from './archive-rules.js';
import {
  createPluginArchiveChecker,
  PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES,
  PLUGIN_ARCHIVE_MAX_ENTRIES,
  PLUGIN_ARCHIVE_MAX_EXTRACTED_BYTES,
  PLUGIN_ARCHIVE_MAX_MANIFEST_BYTES,
  PLUGIN_ARCHIVE_MAX_PATH_BYTES,
  PLUGIN_ARCHIVE_MAX_SEGMENT_BYTES,
} from './archive-rules.js';

const MIB = 1024 * 1024;
const file = (name: string, size = 1) => ({ name, type: 'file', size });
const dir = (name: string) => ({ name, type: 'directory', size: 0 });

describe('plugin archive rules (#1094)', () => {
  it('holds the archive caps (#1094, #1166)', () => {
    expect(PLUGIN_ARCHIVE_MAX_SEGMENT_BYTES).toBe(255);
    expect(PLUGIN_ARCHIVE_MAX_PATH_BYTES).toBe(1024);
    expect(PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES).toBe(100 * MIB);
    expect(PLUGIN_ARCHIVE_MAX_EXTRACTED_BYTES).toBe(512 * MIB);
    expect(PLUGIN_ARCHIVE_MAX_ENTRIES).toBe(50_000);
    expect(PLUGIN_ARCHIVE_MAX_MANIFEST_BYTES).toBe(MIB);
  });

  // The author CLI writes nothing to disk, so a collision the server's
  // extractor would meet there is refused here, and the two agree (#84).
  describe('an entry that collides with an earlier one (#1094)', () => {
    it.each<[string, PluginArchiveEntry[], PluginArchiveEntry]>([
      ['a file named twice', [file('package/a.js')], file('package/a.js')],
      ['a file named again through ./', [file('package/a.js')], file('./package/./a.js')],
      ['a directory over a file', [file('package/dist')], dir('package/dist/')],
      ['a file over a directory', [dir('package/dist/')], file('package/dist')],
      ['a file over a directory a deeper entry made', [file('package/dist/index.js')], file('package/dist')],
      ['a file under a file', [file('package/dist')], file('package/dist/index.js')],
      ['a directory under a file', [file('package/dist')], dir('package/dist/sub/')],
    ])('refuses %s as corrupt, naming the entry (#1094)', (_label, earlier, entry) => {
      const checker = createPluginArchiveChecker();
      for (const accepted of earlier) {
        expect(checker.check(accepted).ok).toBe(true);
      }

      expect(checker.check(entry)).toEqual({ ok: false, rule: 'corrupt', entry: entry.name });
    });

    it('accepts a directory named twice, and one a deeper entry already made (#1094)', () => {
      const checker = createPluginArchiveChecker();

      expect(checker.check(dir('package/dist/')).ok).toBe(true);
      expect(checker.check(dir('package/dist')).ok).toBe(true);
      expect(checker.check(file('package/lib/x.js')).ok).toBe(true);
      expect(checker.check(dir('package/lib/')).ok).toBe(true);
      expect(checker.check(file('package/lib/y.js')).ok).toBe(true);
    });

    it('records only an accepted entry, so a refused one leaves its name free (#1094)', () => {
      const checker = createPluginArchiveChecker();

      expect(checker.check(file('package/big', 600 * MIB)).ok).toBe(false);
      expect(checker.check(file('package/big', 1)).ok).toBe(true);
    });
  });

  describe("the root manifest.json's size (#1094)", () => {
    it('accepts a root manifest.json of exactly 1 MiB and refuses one a byte over, as manifest-size (#1094)', () => {
      expect(createPluginArchiveChecker().check(file('package/manifest.json', MIB)).ok).toBe(true);
      expect(createPluginArchiveChecker().check(file('package/manifest.json', MIB + 1))).toEqual({
        ok: false,
        rule: 'manifest-size',
        entry: 'package/manifest.json',
      });
    });

    it('leaves a nested manifest.json and other root files to the extracted-size cap (#1094)', () => {
      const checker = createPluginArchiveChecker();

      expect(checker.check(file('package/sub/manifest.json', 2 * MIB)).ok).toBe(true);
      expect(checker.check(file('package/package.json', 2 * MIB)).ok).toBe(true);
    });
  });

  it('strips the one top-level directory, npm pack style (#1094)', () => {
    const checker = createPluginArchiveChecker();
    expect(checker.check(file('package/dist/index.js'))).toEqual({
      ok: true,
      path: 'dist/index.js',
      kind: 'file',
    });
  });

  it('accepts the top-level directory entry itself, as a directory with an empty path (#1094)', () => {
    const checker = createPluginArchiveChecker();
    expect(checker.check({ name: 'package/', type: 'directory', size: 0 })).toEqual({
      ok: true,
      path: '',
      kind: 'directory',
    });
    expect(checker.check({ name: 'package', type: 'directory', size: 0 }).ok).toBe(true);
    expect(checker.check(file('package/a.js')).ok).toBe(true);
  });

  it('refuses a second top-level directory entry (#1094)', () => {
    const checker = createPluginArchiveChecker();
    checker.check(file('package/x'));
    expect(checker.check({ name: 'other/', type: 'directory', size: 0 })).toEqual({
      ok: false,
      rule: 'top-level',
      entry: 'other/',
    });
  });

  it('treats a leading ./ as no prefix (#1094)', () => {
    const checker = createPluginArchiveChecker();
    expect(checker.check(file('./package/x'))).toEqual({ ok: true, path: 'x', kind: 'file' });
    expect(checker.check(file('package/y')).ok).toBe(true);
  });

  it('keeps a nested directory entry as a directory (#1094)', () => {
    const checker = createPluginArchiveChecker();
    expect(checker.check({ name: 'package/dist/', type: 'directory', size: 0 })).toEqual({
      ok: true,
      path: 'dist',
      kind: 'directory',
    });
  });

  it.each(['symlink', 'link', 'character-device'])('refuses a %s entry (#1094)', (type) => {
    const checker = createPluginArchiveChecker();
    expect(checker.check({ name: 'package/x', type, size: 0 })).toEqual({
      ok: false,
      rule: 'entry-type',
      entry: 'package/x',
    });
  });

  it.each([
    ['an absolute name', '/abs'],
    ['a .. segment', 'package/../../x'],
    ['a .. segment after ./', './../x'],
    ['a .. segment that normalizes inside', 'package/a/../x'],
    ['a backslash', 'package/a\\b'],
    ['a NUL', 'package/a\u0000b'],
  ])('refuses %s as an unsafe path (#1094)', (_label, name) => {
    const checker = createPluginArchiveChecker();
    expect(checker.check(file(name))).toEqual({ ok: false, rule: 'unsafe-path', entry: name });
  });

  it('refuses a second top-level directory (#1094)', () => {
    const checker = createPluginArchiveChecker();
    checker.check(file('package/x'));
    expect(checker.check(file('other/x'))).toEqual({
      ok: false,
      rule: 'top-level',
      entry: 'other/x',
    });
  });

  it('refuses a file at the top level (#1094)', () => {
    const checker = createPluginArchiveChecker();
    expect(checker.check(file('README'))).toEqual({ ok: false, rule: 'top-level', entry: 'README' });
  });

  it('refuses entry 50,001 and accepts entry 50,000 (#1094)', () => {
    const checker = createPluginArchiveChecker();
    for (let i = 0; i < PLUGIN_ARCHIVE_MAX_ENTRIES; i++) {
      expect(checker.check(file(`package/f${i}`, 0)).ok).toBe(true);
    }

    expect(checker.check(file('package/one-too-many', 0))).toEqual({
      ok: false,
      rule: 'entry-count',
      entry: 'package/one-too-many',
    });
  });

  describe('the paths an archive creates (#1166)', () => {
    // 25,000 directories each holding a file create 50,000 paths from only
    // 25,000 entries, so the listed-entry cap never trips (#1166).
    it('refuses the entry that would create path 50,001, though few entries were listed (#1166)', () => {
      const checker = createPluginArchiveChecker();
      for (let i = 0; i < PLUGIN_ARCHIVE_MAX_ENTRIES / 2; i++) {
        expect(checker.check(file(`package/d${i}/f`, 0)).ok).toBe(true);
      }

      expect(checker.check(file('package/d25000/f', 0))).toEqual({
        ok: false,
        rule: 'entry-count',
        entry: 'package/d25000/f',
      });
    });

    it('counts a directory both listed and implied once (#1166)', () => {
      const checker = createPluginArchiveChecker();
      expect(checker.check(dir('package/d0/')).ok).toBe(true);
      for (let i = 0; i < PLUGIN_ARCHIVE_MAX_ENTRIES / 2; i++) {
        expect(checker.check(file(`package/d${i}/f`, 0)).ok).toBe(true);
      }

      expect(checker.check(file('package/d25000/f', 0))).toEqual({
        ok: false,
        rule: 'entry-count',
        entry: 'package/d25000/f',
      });
    });

    it('counts a directory both implied and then listed once (#1166)', () => {
      const checker = createPluginArchiveChecker();
      expect(checker.check(file('package/d0/f', 0)).ok).toBe(true);
      expect(checker.check(dir('package/d0/')).ok).toBe(true);
      for (let i = 1; i < PLUGIN_ARCHIVE_MAX_ENTRIES / 2; i++) {
        expect(checker.check(file(`package/d${i}/f`, 0)).ok).toBe(true);
      }

      expect(checker.check(file('package/d25000/f', 0))).toEqual({
        ok: false,
        rule: 'entry-count',
        entry: 'package/d25000/f',
      });
    });

    it('creates no paths for a refused entry, so the cap still allows exactly 50,000 (#1166)', () => {
      const checker = createPluginArchiveChecker();
      expect(checker.check(file(`package/deep/${'a'.repeat(256)}`, 0))).toMatchObject({
        ok: false,
        rule: 'unsafe-path',
      });

      for (let i = 0; i < PLUGIN_ARCHIVE_MAX_ENTRIES; i++) {
        expect(checker.check(file(`package/f${i}`, 0)).ok).toBe(true);
      }

      expect(checker.check(file('package/one-too-many', 0))).toEqual({
        ok: false,
        rule: 'entry-count',
        entry: 'package/one-too-many',
      });
    });
  });

  describe('the length of a name (#1166)', () => {
    const SEGMENT_BYTES = PLUGIN_ARCHIVE_MAX_SEGMENT_BYTES;

    it('accepts a 255-byte segment and refuses a 256-byte one as unsafe-path (#1166)', () => {
      expect(createPluginArchiveChecker().check(file(`package/${'a'.repeat(SEGMENT_BYTES)}`)).ok).toBe(true);

      const tooLong = `package/${'a'.repeat(SEGMENT_BYTES + 1)}`;
      expect(createPluginArchiveChecker().check(file(tooLong))).toEqual({
        ok: false,
        rule: 'unsafe-path',
        entry: tooLong,
      });
    });

    it('counts a segment in UTF-8 bytes, not characters (#1166)', () => {
      // 'é' is two bytes: 127 of them and an 'a' make 255, 128 make 256.
      expect(createPluginArchiveChecker().check(file(`package/${'é'.repeat(127)}a`)).ok).toBe(true);

      const tooLong = `package/${'é'.repeat(128)}`;
      expect(createPluginArchiveChecker().check(file(tooLong))).toEqual({
        ok: false,
        rule: 'unsafe-path',
        entry: tooLong,
      });
    });

    it('holds the top-level directory to the segment cap too (#1166)', () => {
      const tooLong = `${'t'.repeat(SEGMENT_BYTES + 1)}/`;

      expect(createPluginArchiveChecker().check(dir(tooLong))).toEqual({
        ok: false,
        rule: 'unsafe-path',
        entry: tooLong,
      });
    });

    it('accepts a stripped path of exactly 1,024 bytes and refuses one byte more as unsafe-path (#1166)', () => {
      const directories = Array.from({ length: 4 }, (_, i) => String(i).repeat(200));
      const nameOf = (fileBytes: number) => `package/${directories.join('/')}/${'f'.repeat(fileBytes)}`;

      // 4 x 200 + 4 slashes + 220 = 1,024
      expect(createPluginArchiveChecker().check(file(nameOf(220))).ok).toBe(true);
      expect(createPluginArchiveChecker().check(file(nameOf(221)))).toEqual({
        ok: false,
        rule: 'unsafe-path',
        entry: nameOf(221),
      });
    });

    it('counts the path cap in UTF-8 bytes, not characters (#1166)', () => {
      // 4 directories of 100 'é' (200 bytes each) + 4 slashes + 220 = 1,024 bytes, in far fewer characters.
      const directories = Array.from({ length: 4 }, () => 'é'.repeat(100));
      const nameOf = (fileBytes: number) => `package/${directories.join('/')}/${'a'.repeat(fileBytes)}`;

      expect(createPluginArchiveChecker().check(file(nameOf(220))).ok).toBe(true);
      expect(createPluginArchiveChecker().check(file(nameOf(221)))).toEqual({
        ok: false,
        rule: 'unsafe-path',
        entry: nameOf(221),
      });
    });
  });

  it('refuses a running total over 512 MiB (#1094)', () => {
    const checker = createPluginArchiveChecker();
    expect(checker.check(file('package/a', 300 * MIB)).ok).toBe(true);
    expect(checker.check(file('package/b', 300 * MIB))).toEqual({
      ok: false,
      rule: 'extracted-size',
      entry: 'package/b',
    });
  });

  it('accepts a running total exactly at 512 MiB (#1094)', () => {
    const checker = createPluginArchiveChecker();
    expect(checker.check(file('package/a', 256 * MIB)).ok).toBe(true);
    expect(checker.check(file('package/b', 256 * MIB)).ok).toBe(true);
    expect(checker.check(file('package/c', 1)).ok).toBe(false);
  });

  it('finish refuses an archive without package.json (#1094)', () => {
    const checker = createPluginArchiveChecker();
    checker.check(file('package/manifest.json'));
    expect(checker.finish()).toEqual({ ok: false, rule: 'required-file', entry: 'package.json' });
  });

  it('finish refuses an archive without manifest.json (#1094)', () => {
    const checker = createPluginArchiveChecker();
    checker.check(file('package/package.json'));
    expect(checker.finish()).toEqual({ ok: false, rule: 'required-file', entry: 'manifest.json' });
  });

  it('finish does not count a nested manifest.json or a directory of that name (#1094)', () => {
    const checker = createPluginArchiveChecker();
    checker.check(file('package/package.json'));
    checker.check(file('package/sub/manifest.json'));
    checker.check({ name: 'package/manifest.json/', type: 'directory', size: 0 });
    expect(checker.finish().ok).toBe(false);
  });

  it('finish passes with both required files at the stripped root (#1094)', () => {
    const checker = createPluginArchiveChecker();
    checker.check(file('package/package.json'));
    checker.check(file('package/manifest.json'));
    expect(checker.finish()).toEqual({ ok: true });
  });

  it.each([NaN, -1, Infinity, 1.5])('refuses a size of %s as corrupt (#1094)', (size) => {
    const checker = createPluginArchiveChecker();
    expect(checker.check(file('package/x', size))).toEqual({
      ok: false,
      rule: 'corrupt',
      entry: 'package/x',
    });
  });

  it('keeps the running total sound after a refused size (#1094)', () => {
    const checker = createPluginArchiveChecker();
    checker.check(file('package/bad', NaN));
    expect(checker.check(file('package/a', 300 * MIB)).ok).toBe(true);
    expect(checker.check(file('package/b', 300 * MIB)).ok).toBe(false);
  });

  it('refuses a file whose name ends in a slash, so it cannot pass for a required file (#1094)', () => {
    const checker = createPluginArchiveChecker();
    expect(checker.check(file('package/package.json/'))).toEqual({
      ok: false,
      rule: 'unsafe-path',
      entry: 'package/package.json/',
    });
  });

  describe('odd but pinned names (#1094)', () => {
    it('collapses a doubled slash', () => {
      expect(createPluginArchiveChecker().check(file('package//x'))).toEqual({
        ok: true,
        path: 'x',
        kind: 'file',
      });
    });

    it('refuses a bare dot as top-level', () => {
      expect(createPluginArchiveChecker().check(file('.'))).toEqual({
        ok: false,
        rule: 'top-level',
        entry: '.',
      });
    });

    it('refuses a trailing .. segment as unsafe', () => {
      expect(createPluginArchiveChecker().check(file('package/..'))).toEqual({
        ok: false,
        rule: 'unsafe-path',
        entry: 'package/..',
      });
    });

    it('treats a three-dot segment as an ordinary name', () => {
      expect(createPluginArchiveChecker().check(file('package/.../x'))).toEqual({
        ok: true,
        path: '.../x',
        kind: 'file',
      });
    });

    it('compares the top-level directory case-sensitively', () => {
      const checker = createPluginArchiveChecker();
      checker.check(file('package/x'));
      expect(checker.check(file('Package/y'))).toEqual({
        ok: false,
        rule: 'top-level',
        entry: 'Package/y',
      });
    });
  });
});
