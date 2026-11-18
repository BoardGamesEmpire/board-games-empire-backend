import type { MockDatabaseService } from '@bge/testing';
import { createTestingModuleWithDb } from '@bge/testing';
import type { PolicyText } from './policy-file';
import { PrivacyPolicyFilesService } from './privacy-policy-files.service';
import type { PrivacyPolicyLanguageRequest } from './privacy-policy.service';
import { PrivacyPolicyService } from './privacy-policy.service';

/** A policy file's text in `language`, dated 2026-11-18. */
const file = (language: string, source: PolicyText['source'] = 'standard'): PolicyText => ({
  language,
  markdown: `# ${language} file\n`,
  source,
  updatedAt: new Date('2026-11-18T00:00:00.000Z'),
});

/**
 * A server admin's row in `language`, as the database stores it. It carries the
 * columns the answer must never show, so a read that passes the row through
 * would show them.
 */
const row = (language: string, updatedAt = '2026-12-01T10:20:30.000Z') => ({
  createdAt: new Date('2026-11-30T00:00:00.000Z'),
  id: `row-${language}`,
  languageTag: { id: `tag-${language}`, tag: language },
  languageTagId: `tag-${language}`,
  markdown: `# ${language} row\n`,
  updatedAt: new Date(updatedAt),
});

describe('PrivacyPolicyService (#934)', () => {
  let service: PrivacyPolicyService;
  let db: MockDatabaseService;
  let texts: Map<string, PolicyText>;

  /** The policy files the server booted with. */
  function givenFiles(...files: PolicyText[]): void {
    texts = new Map(files.map((text) => [text.language, text]));
  }

  /** The server admins' rows in the database. */
  function givenRows(...rows: ReturnType<typeof row>[]): void {
    db.privacyPolicy.findMany.mockResolvedValue(rows as never);
  }

  beforeEach(async () => {
    texts = new Map();
    const files = {
      get: (language: string) => texts.get(language),
      languages: () => [...texts.keys()].sort(),
    } satisfies Pick<PrivacyPolicyFilesService, 'get' | 'languages'>;

    const ctx = await createTestingModuleWithDb({
      providers: [PrivacyPolicyService, { provide: PrivacyPolicyFilesService, useValue: files }],
    });

    db = ctx.db;
    service = ctx.module.get(PrivacyPolicyService);
    givenRows();
  });

  it('serves the file when no row exists for the language', async () => {
    givenFiles(file('en'), file('de', 'operator'));

    await expect(service.read({ lang: 'de' })).resolves.toEqual({
      availableLanguages: ['de', 'en'],
      language: 'de',
      markdown: '# de file\n',
      source: 'operator',
      updatedAt: '2026-11-18T00:00:00.000Z',
    });
    await expect(service.read({})).resolves.toEqual({
      availableLanguages: ['de', 'en'],
      language: 'en',
      markdown: '# en file\n',
      source: 'standard',
      updatedAt: '2026-11-18T00:00:00.000Z',
    });
  });

  it("serves the row over the file for the same language, as the operator's", async () => {
    givenFiles(file('en'), file('de'));
    givenRows(row('de'));

    await expect(service.read({ lang: 'de' })).resolves.toEqual({
      availableLanguages: ['de', 'en'],
      language: 'de',
      markdown: '# de row\n',
      source: 'operator',
      updatedAt: '2026-12-01T10:20:30.000Z',
    });
  });

  it('tries lang first, then Accept-Language, then English', async () => {
    givenFiles(file('en'), file('de'), file('fr'));

    const languageFor = async (input: PrivacyPolicyLanguageRequest) => (await service.read(input)).language;

    expect(await languageFor({ lang: 'fr', acceptLanguage: 'de' })).toBe('fr');
    expect(await languageFor({ lang: 'es', acceptLanguage: 'de' })).toBe('de');
    expect(await languageFor({ acceptLanguage: 'es, de;q=0.5' })).toBe('de');
    expect(await languageFor({ lang: 'es', acceptLanguage: 'it' })).toBe('en');
    expect(await languageFor({ acceptLanguage: null })).toBe('en');
  });

  it('matches a regional request to the base language', async () => {
    givenFiles(file('en'), file('de'));

    expect((await service.read({ acceptLanguage: 'de-AT,de;q=0.9' })).language).toBe('de');
    expect((await service.read({ lang: 'DE-at' })).language).toBe('de');
  });

  it('lists every language from rows and files once, sorted', async () => {
    givenFiles(file('fr'), file('en'), file('de'));
    givenRows(row('pt-BR'), row('de'));

    expect((await service.read({})).availableLanguages).toEqual(['de', 'en', 'fr', 'pt-BR']);
  });

  // A row may be in a language no file has; it is served like any other.
  it('serves a row in a language with no file', async () => {
    givenFiles(file('en'));
    givenRows(row('pt-BR'));

    expect(await service.read({ acceptLanguage: 'pt-BR' })).toMatchObject({
      language: 'pt-BR',
      markdown: '# pt-BR row\n',
      source: 'operator',
    });
  });

  it('falls back to English for a lang that is not a tag', async () => {
    givenFiles(file('en'), file('de'));

    await expect(service.read({ lang: '@@' })).resolves.toMatchObject({ language: 'en', markdown: '# en file\n' });
  });

  it('answers only the five public fields', async () => {
    givenFiles(file('en'));
    givenRows(row('en'));

    const fromRow = await service.read({});

    givenRows();
    const fromFile = await service.read({});

    for (const answer of [fromRow, fromFile]) {
      expect(Object.keys(answer).sort()).toEqual(['availableLanguages', 'language', 'markdown', 'source', 'updatedAt']);
    }

    expect(fromRow.source).toBe('operator');
    expect(fromFile.source).toBe('standard');
  });
});
