import { sanitizeMarkdown } from '@bge/content-format';
import { PRIVACY_POLICY_DIR } from '@bge/i18n';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parsePolicyFile } from './policy-file';
import { PRIVACY_POLICY_MAX_LENGTH } from './privacy-policy.constants';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** A policy file's bytes: front matter dated 2026-11-18, then the body. */
const policyFile = (body: string): Buffer => Buffer.from(`---\nupdated: 2026-11-18\n---\n${body}`);

/** Every standard privacy policy the server ships, by file name. */
const shippedFiles = (): Array<[string, Buffer]> =>
  readdirSync(PRIVACY_POLICY_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => [name, readFileSync(path.join(PRIVACY_POLICY_DIR, name))]);

describe('parsePolicyFile (#934)', () => {
  it('reads the language from the file name and the date from the front matter', () => {
    expect(parsePolicyFile('en.md', policyFile('# Privacy\n'))).toEqual({
      language: 'en',
      markdown: '# Privacy\n',
      source: 'operator',
      updatedAt: new Date('2026-11-18T00:00:00.000Z'),
    });
    // Blank lines between the front matter and the text are not part of it.
    expect(parsePolicyFile('en.md', policyFile('\n \n# Privacy\n'))).toMatchObject({ markdown: '# Privacy\n' });
  });

  it('canonicalizes the tag', () => {
    expect(parsePolicyFile('en-us.md', policyFile('# Privacy\n'))).toMatchObject({ language: 'en-US' });
  });

  // An editor on Windows may save a byte order mark and CRLF line endings.
  it('reads a file edited on Windows', () => {
    const windows = Buffer.concat([
      BOM,
      Buffer.from('---\r\nupdated: 2026-11-18\r\n---\r\n# Privacy\r\n\r\nText.\r\n'),
    ]);

    expect(parsePolicyFile('en.md', windows)).toEqual(parsePolicyFile('en.md', policyFile('# Privacy\n\nText.\n')));
  });

  it('refuses a name that is not a language tag', () => {
    expect(parsePolicyFile('deutsch.md', policyFile('# Datenschutz\n'))).toEqual({ problem: 'not-a-language-tag' });
  });

  it('refuses a missing, extra-keyed or impossible date', () => {
    const files = [
      '# Privacy\n',
      '---\nupdated: 2026-11-18\ntitle: Privacy\n---\n# Privacy\n',
      '---\nupdated: 2026-13-40\n---\n# Privacy\n',
      '---\nupdated: 2026-02-30\n---\n# Privacy\n',
    ];

    expect(files.map((file) => parsePolicyFile('en.md', Buffer.from(file)))).toEqual(
      files.map(() => ({ problem: 'no-valid-date' })),
    );
  });

  // Whitespace with no line end passes the sanitizer unchanged, so it shows
  // that what's left is trimmed before it counts as text.
  it('refuses a body that sanitizes to nothing', () => {
    const bodies = ['<script>x</script>\n', '   \n', ' \t '];

    expect(bodies.map((body) => parsePolicyFile('en.md', policyFile(body)))).toEqual(
      bodies.map(() => ({ problem: 'empty' })),
    );
  });

  // The length is checked before sanitizing, so the sanitizer never sees text
  // past the bound where it keeps Markdown as plain text. Sanitized first, the
  // padded text below would shrink under the limit and be served with its
  // heading flattened to plain text.
  it('refuses a body over the limit', () => {
    const padded = `# Privacy\n\n${'a'.repeat(PRIVACY_POLICY_MAX_LENGTH - 100)}${'\n'.repeat(200)}`;

    expect(parsePolicyFile('en.md', policyFile('a'.repeat(PRIVACY_POLICY_MAX_LENGTH + 1)))).toEqual({
      problem: 'too-long',
    });
    expect(parsePolicyFile('en.md', policyFile(padded))).toEqual({ problem: 'too-long' });
    expect(parsePolicyFile('en.md', policyFile('a'.repeat(PRIVACY_POLICY_MAX_LENGTH)))).toMatchObject({
      language: 'en',
    });
  });

  // The limit must stay within the sanitizer's own bound, past which it keeps
  // Markdown as plain text and escapes the heading below as `\# Privacy`, so a
  // limit raised past that bound fails here.
  it('keeps the headings of a body at the limit', () => {
    const heading = '# Privacy\n\n';
    const atLimit = `${heading}${'a'.repeat(PRIVACY_POLICY_MAX_LENGTH - heading.length)}`;

    expect(atLimit).toHaveLength(PRIVACY_POLICY_MAX_LENGTH);
    expect(parsePolicyFile('en.md', policyFile(atLimit))).toMatchObject({ markdown: atLimit });
  });

  it("marks a file that matches a pinned hash as standard, and any other as the operator's", () => {
    const sources = (files: Array<[string, Buffer]>) =>
      files.map(([name, bytes]) => {
        const parsed = parsePolicyFile(name, bytes);
        return [name, 'source' in parsed ? parsed.source : parsed.problem];
      });

    const shipped = shippedFiles();
    const edited = shipped.map(([name, bytes]): [string, Buffer] => [
      name,
      Buffer.concat([bytes, Buffer.from('\nOne more line.\n')]),
    ]);
    const english = readFileSync(path.join(PRIVACY_POLICY_DIR, 'en.md'));

    expect(sources(shipped)).toEqual(shipped.map(([name]) => [name, 'standard']));
    expect(sources(edited)).toEqual(shipped.map(([name]) => [name, 'operator']));
    // A hash counts only for the language it is pinned under.
    expect(sources([['en-GB.md', english]])).toEqual([['en-GB.md', 'operator']]);
  });
});

// The standard text sits in `@bge/i18n-core`, whose own spec can't load the
// sanitizer: that import would close a project cycle back to it through
// `@bge/database`. So it is checked here, where the files are read (#934).
describe('the standard privacy policy (#934)', () => {
  it("is unchanged by the server's Markdown sanitizing", () => {
    // The body as served: after the front matter and the blank lines below it.
    const changed = shippedFiles()
      .map(
        ([name, bytes]) =>
          [name, bytes.toString('utf8').replace(/^---\nupdated: [^\n]*\n---\n(?:[ \t]*\n)*/, '')] as const,
      )
      .filter(([, body]) => sanitizeMarkdown(body) !== body)
      .map(([name]) => name);

    expect(changed).toEqual([]);
  });
});
