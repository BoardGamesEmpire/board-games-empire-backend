import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { PolicyFileContents } from './privacy-policy';
import { PRIVACY_POLICY_DIR, readPolicyFile, STANDARD_PRIVACY_POLICY_HASHES } from './privacy-policy';

/**
 * What would tell an attacker about the server's insides: addresses, ports and
 * version numbers (#934).
 */
const REVEALING_PATTERNS = [/https?:\/\//, /\blocalhost\b/i, /:\d{2,5}\b/, /\b\d+\.\d+(\.\d+)?\b/];

/**
 * Libraries, internal services, storage and how secrets are kept (#934). Each
 * matches as a whole word, alone or with a plural "s", so "tables" fails while
 * "suitable" and "honest" pass.
 */
const REVEALING_WORDS = [
  'postgres',
  'postgresql',
  'redis',
  'dragonfly',
  'prisma',
  'nestjs',
  'better-auth',
  'bullmq',
  'minio',
  's3',
  'grpc',
  'docker',
  'kubernetes',
  'encrypted',
  'encryption',
  'bcrypt',
  'argon2',
  'secret',
  'table',
  'column',
];

interface ShippedText extends PolicyFileContents {
  language: string;
}

/** Every policy file in the directory, read as the server reads it. */
function shippedTexts(): ShippedText[] {
  return readdirSync(PRIVACY_POLICY_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const file = readPolicyFile(readFileSync(path.join(PRIVACY_POLICY_DIR, name)));
      if (!file) {
        throw new Error(`${name} does not start with the front matter "---\\nupdated: YYYY-MM-DD\\n---\\n"`);
      }

      return { ...file, language: path.basename(name, '.md') };
    });
}

// That the text survives the server's Markdown sanitizing is checked where the
// files are read: importing `@bge/content-format` here would close a project
// cycle back to this lib through `@bge/database` (#934).
describe('the standard privacy policy (#934)', () => {
  it('pins every shipped standard text to the date in its front matter', () => {
    const unpinned = shippedTexts()
      .filter(({ hash, language, updated }) => STANDARD_PRIVACY_POLICY_HASHES[language]?.[updated] !== hash)
      .map(
        ({ hash, language, updated }) =>
          `${language}.md (updated ${updated}) is not pinned: when its text changes, move "updated" to today ` +
          `and add today's date to STANDARD_PRIVACY_POLICY_HASHES.${language} with the hash ${hash}. ` +
          'Add a new date entry; never edit an older one.',
      );

    expect(unpinned).toEqual([]);
  });

  it("keeps each language's pinned dates in order, with the newest matching the file", () => {
    const updatedByLanguage = new Map(shippedTexts().map(({ language, updated }) => [language, updated]));

    for (const [language, pins] of Object.entries(STANDARD_PRIVACY_POLICY_HASHES)) {
      const dates = Object.keys(pins);

      expect(dates).toEqual([...dates].sort());
      expect({ language, newest: dates.at(-1) }).toEqual({ language, newest: updatedByLanguage.get(language) });
    }
  });

  it('ships English, the fallback', () => {
    expect(existsSync(path.join(PRIVACY_POLICY_DIR, 'en.md'))).toBe(true);
  });

  it('says nothing that helps an attacker', () => {
    const patterns = [...REVEALING_PATTERNS, ...REVEALING_WORDS.map((word) => new RegExp(`\\b${word}s?\\b`, 'i'))];
    const found = shippedTexts().flatMap(({ body, language }) =>
      patterns.filter((pattern) => pattern.test(body)).map((pattern) => `${language}.md matches ${pattern}`),
    );

    expect(found).toEqual([]);
  });
});

describe('readPolicyFile (#934)', () => {
  const lf = '---\nupdated: 2026-11-18\n---\n\n# Privacy\n\nText.\n';

  it('reads the date, and the body below the blank lines after the front matter', () => {
    expect(readPolicyFile(Buffer.from(lf))).toMatchObject({ updated: '2026-11-18', body: '# Privacy\n\nText.\n' });
  });

  it('answers null for a file without the front matter', () => {
    expect(readPolicyFile(Buffer.from('# Privacy\n'))).toBeNull();
  });

  // A standard text checked out with CRLF line endings (`core.autocrlf`), or
  // saved unchanged by an editor that writes them or a byte order mark, is
  // still the standard text, so its hash must not move.
  it('reads a byte order mark and CRLF line endings as a Unix editor would save the file, hash included', () => {
    const windows = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lf.replaceAll('\n', '\r\n'))]);

    expect(readPolicyFile(windows)).toEqual(readPolicyFile(Buffer.from(lf)));
  });
});
