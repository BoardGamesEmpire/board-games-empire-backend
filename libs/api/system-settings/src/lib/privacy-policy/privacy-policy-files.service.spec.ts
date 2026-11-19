import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PRIVACY_POLICY_DIR_TOKEN, PrivacyPolicyFilesService } from './privacy-policy-files.service';

/** A policy file's text: front matter dated 2026-11-18, then the body. */
const policy = (body: string): string => `---\nupdated: 2026-11-18\n---\n${body}`;

describe('PrivacyPolicyFilesService (#934)', () => {
  let dir: string;
  let warn: jest.SpyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bge-privacy-policy-'));
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes each file under the directory, making the folders its path names. */
  async function write(files: Record<string, string | Buffer>): Promise<void> {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), content);
    }
  }

  /** The service as the module wires it, reading `directory`, before boot. */
  async function filesIn(directory = dir): Promise<PrivacyPolicyFilesService> {
    const module = await Test.createTestingModule({
      providers: [PrivacyPolicyFilesService, { provide: PRIVACY_POLICY_DIR_TOKEN, useValue: directory }],
    }).compile();

    return module.get(PrivacyPolicyFilesService);
  }

  async function boot(): Promise<PrivacyPolicyFilesService> {
    const files = await filesIn();
    await files.onModuleInit();
    return files;
  }

  const warnings = (): string[] => warn.mock.calls.map(([message]) => String(message));

  it('fails the boot naming en.md when the fallback is missing', async () => {
    await write({ 'fr.md': policy('# Confidentialité\n') });

    const booting = (await filesIn()).onModuleInit();

    await expect(booting).rejects.toThrow(Error);
    await expect(booting).rejects.toThrow(/needs a privacy policy in English.* no en\.md /);
  });

  it('fails the boot when en.md is malformed', async () => {
    await write({ 'en.md': '# Privacy\n', 'fr.md': policy('# Confidentialité\n') });

    await expect((await filesIn()).onModuleInit()).rejects.toThrow(
      /needs a privacy policy in English.* en\.md .*\(no-valid-date\)/,
    );
  });

  // `eng` canonicalizes to `en`, so eng.md names the fallback's file too. Which
  // of two such files sorts first must not decide whether the server starts:
  // with one usable, the other is skipped with a warning. On Linux, `EN.md`
  // sorts before `en.md` the way en.md sorts before eng.md here.
  it('boots on a usable file in English beside an unusable alias, whichever sorts first', async () => {
    await write({ 'en.md': policy('# Privacy\n'), 'eng.md': '# Privacy\n' });

    const first = await boot();

    expect(first.get('en')).toMatchObject({ markdown: '# Privacy\n' });
    expect(warnings()).toEqual([expect.stringMatching(/ eng\.md, which can't be used \(no-valid-date\).* en\.md /)]);

    warn.mockClear();
    await write({ 'en.md': '# Privacy\n', 'eng.md': policy('# English\n') });

    const second = await boot();

    expect(second.get('en')).toMatchObject({ markdown: '# English\n' });
    expect(warnings()).toEqual([expect.stringMatching(/ en\.md, which can't be used \(no-valid-date\).* eng\.md /)]);
  });

  // Docker makes a directory where a bind mount's file is missing on the host,
  // so `ls` shows an en.md that isn't one.
  it('fails the boot saying en.md is not a file when it is a directory', async () => {
    await write({ 'en.md/README': 'not a policy', 'fr.md': policy('# Confidentialité\n') });

    await expect((await filesIn()).onModuleInit()).rejects.toThrow(
      /needs a privacy policy in English.* en\.md .* is not a file/,
    );
  });

  it('fails the boot naming the directory when it cannot be read', async () => {
    const missing = path.join(dir, 'missing');

    await expect((await filesIn(missing)).onModuleInit()).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/needs a privacy policy in English.* directory .* can't be read/),
        cause: expect.objectContaining({ code: 'ENOENT' }),
      }),
    );
    await expect((await filesIn(missing)).onModuleInit()).rejects.toThrow(missing);
  });

  it('warns and skips any other malformed file, keeping the rest', async () => {
    await write({
      'de.md': '# Datenschutz\n',
      'en.md': policy('# Privacy\n'),
      'fr.md': policy('# Confidentialité\n'),
    });

    const files = await boot();

    expect(files.languages()).toEqual(['en', 'fr']);
    expect(files.get('de')).toBeUndefined();
    expect(warnings()).toEqual([expect.stringMatching(/ de\.md .*\(no-valid-date\)/)]);
  });

  // A Kubernetes ConfigMap mounts each key as a symlink through `..data`, a
  // symlink to a timestamped directory, so an update can swap them at once.
  it('skips dot-entries and directories silently, and follows symlinks', async () => {
    const version = '..2026_11_18_12_00_00.000000001';
    await write({
      [`${version}/en.md`]: policy('# Privacy\n'),
      [`${version}/fr.md`]: policy('# Confidentialité\n'),
      '.gitkeep': '',
      'drafts/de.md': policy('# Datenschutz\n'),
    });
    await symlink(version, path.join(dir, '..data'));
    await symlink('..data/en.md', path.join(dir, 'en.md'));
    await symlink('..data/fr.md', path.join(dir, 'fr.md'));

    const files = await boot();

    expect(files.languages()).toEqual(['en', 'fr']);
    expect(files.get('en')).toMatchObject({ language: 'en', markdown: '# Privacy\n' });
    expect(warnings()).toEqual([]);
  });

  // A bad mount can leave a symlink that points at nothing. An entry named
  // `en` without `.md` isn't a policy file, so it only warns.
  it('warns about and skips a file it cannot read, but fails the boot when that is en.md', async () => {
    await write({ 'en.md': policy('# Privacy\n') });
    await symlink('gone.md', path.join(dir, 'de.md'));
    await symlink('gone', path.join(dir, 'en'));

    const files = await boot();

    expect(files.languages()).toEqual(['en']);
    expect(warnings()).toEqual([
      expect.stringMatching(/ de\.md \(unreadable\)/),
      expect.stringMatching(/ en \(unreadable\)/),
    ]);

    await rm(path.join(dir, 'en.md'));
    await symlink('gone.md', path.join(dir, 'en.md'));

    await expect((await filesIn()).onModuleInit()).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/needs a privacy policy in English.* en\.md .*\(unreadable\):.*ENOENT/),
        cause: expect.objectContaining({ code: 'ENOENT' }),
      }),
    );
  });

  it('warns about and skips a non-Markdown file', async () => {
    await write({ 'README.txt': 'Mount your privacy policy here.', 'en.md': policy('# Privacy\n') });

    const files = await boot();

    expect(files.languages()).toEqual(['en']);
    expect(warnings()).toEqual([expect.stringContaining(' README.txt ')]);
  });

  // `iw` is Hebrew's withdrawn code, which canonicalizes to `he`. Two names
  // that differ only in case can't share a directory on a case-insensitive
  // file system, so this pair stands in for `en-US.md` and `en-us.md`.
  it('keeps the first of two files that canonicalize to the same tag, and warns about the second', async () => {
    await write({ 'en.md': policy('# Privacy\n'), 'iw.md': policy('# iw\n'), 'he.md': policy('# he\n') });

    const files = await boot();

    expect(files.languages()).toEqual(['en', 'he']);
    expect(files.get('he')).toMatchObject({ markdown: '# he\n' });
    expect(warnings()).toEqual([expect.stringMatching(/ iw\.md .* he\.md /)]);
  });

  it('reads a file edited on Windows', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await write({
      'en.md': Buffer.concat([bom, Buffer.from('---\r\nupdated: 2026-11-18\r\n---\r\n# Privacy\r\n\r\nText.\r\n')]),
    });

    const files = await boot();

    expect(files.get('en')).toEqual({
      language: 'en',
      markdown: '# Privacy\n\nText.\n',
      source: 'operator',
      updatedAt: new Date('2026-11-18T00:00:00.000Z'),
    });
  });

  it('reads the standard privacy policy when no directory is given', async () => {
    const module = await Test.createTestingModule({ providers: [PrivacyPolicyFilesService] }).compile();
    await module.init();

    const files = module.get(PrivacyPolicyFilesService);

    expect(files.languages()).toContain('en');
    expect(files.get('en')).toMatchObject({ language: 'en', source: 'standard' });
    expect(warnings()).toEqual([]);
  });
});
