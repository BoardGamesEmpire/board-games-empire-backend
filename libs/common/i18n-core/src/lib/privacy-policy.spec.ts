import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { PRIVACY_POLICY_DIR, STANDARD_PRIVACY_POLICY_HASHES } from './privacy-policy';

/** A byte order mark, which an editor may put at the start of a file. */
const BOM = String.fromCodePoint(0xfeff);

/**
 * The front matter every policy file starts with (#934): after an optional
 * BOM, only the date the text last changed. CRLF reads as LF.
 */
const FRONT_MATTER = new RegExp(`^${BOM}?---\\r?\\nupdated: (\\d{4}-\\d{2}-\\d{2})\\r?\\n---\\r?\\n`);

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

interface ShippedText {
  body: string;
  bytes: Buffer;
  language: string;
  updated: string;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Every policy file in the directory, with its front matter read and the body after it. */
function shippedTexts(): ShippedText[] {
  return readdirSync(PRIVACY_POLICY_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const bytes = readFileSync(path.join(PRIVACY_POLICY_DIR, name));
      const text = bytes.toString('utf8');
      const frontMatter = FRONT_MATTER.exec(text);
      if (!frontMatter?.[1]) {
        throw new Error(`${name} does not start with the front matter "---\\nupdated: YYYY-MM-DD\\n---\\n"`);
      }

      return {
        body: text.slice(frontMatter[0].length),
        bytes,
        language: path.basename(name, '.md'),
        updated: frontMatter[1],
      };
    });
}

// That the text survives the server's Markdown sanitizing is checked where the
// files are read: importing `@bge/content-format` here would close a project
// cycle back to this lib through `@bge/database` (#934).
describe('the standard privacy policy (#934)', () => {
  it('pins every shipped standard text to the date in its front matter', () => {
    const unpinned = shippedTexts()
      .filter(({ bytes, language, updated }) => STANDARD_PRIVACY_POLICY_HASHES[language]?.[updated] !== sha256(bytes))
      .map(
        ({ bytes, language, updated }) =>
          `${language}.md (updated ${updated}) is not pinned: when its text changes, move "updated" to today ` +
          `and add today's date to STANDARD_PRIVACY_POLICY_HASHES.${language} with the hash ${sha256(bytes)}. ` +
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
