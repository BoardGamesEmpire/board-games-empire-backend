import { Prisma, ResourceType } from '@bge/database';
import type { MockDatabaseService } from '@bge/testing';
import { createMockDatabaseService, createTestingModuleWithDb, rawQueryText, unwrapTransaction } from '@bge/testing';
import { HttpStatus } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { PolicyText } from './policy-file';
import { PrivacyPolicyFilesService } from './privacy-policy-files.service';
import { PRIVACY_POLICY_MAX_LENGTH, PrivacyPolicyErrorCode } from './privacy-policy.constants';
import { PrivacyPolicyEvents, PrivacyPolicyRemovedEvent, PrivacyPolicyReplacedEvent } from './privacy-policy.events';
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

/** When a write in these specs lands. */
const WRITTEN_AT = new Date('2026-12-02T08:00:00.000Z');

/** A server admin's row as the write's select returns it: the event's snapshot. */
const snapshot = (languageTagId: string, markdown: string, updatedAt = WRITTEN_AT) => ({
  id: `policy-${languageTagId}`,
  languageTagId,
  markdown,
  updatedAt,
});

/** The columns the write reads and returns: the snapshot's. */
const SNAPSHOT_SELECT = { id: true, languageTagId: true, markdown: true, updatedAt: true };

/** The lock every write takes first, on the language tag's row. */
const LANGUAGE_TAG_LOCK = 'SELECT id FROM language_tags WHERE tag = ? FOR NO KEY UPDATE';

const recordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('Record to delete does not exist', { code: 'P2025', clientVersion: 'test' });

/** A refusal with the privacy policy's `code` and catalog `key`, as the exception carries them. */
const refusal = (status: HttpStatus, code: PrivacyPolicyErrorCode, key: string, args?: Record<string, unknown>) => ({
  status,
  response: expect.objectContaining({
    code,
    message: expect.objectContaining({ key, ...(args && { args }) }),
  }),
});

describe('PrivacyPolicyService (#934)', () => {
  let service: PrivacyPolicyService;
  let db: MockDatabaseService;
  let texts: Map<string, PolicyText>;
  let emitter: { emit: jest.Mock };

  /** The policy files the server booted with. */
  function givenFiles(...files: PolicyText[]): void {
    texts = new Map(files.map((text) => [text.language, text]));
  }

  /**
   * The server admins' rows in the database: listed whole by `findMany`, and
   * found one at a time by language with `findFirst`.
   */
  function givenRows(...rows: ReturnType<typeof row>[]): void {
    db.privacyPolicy.findMany.mockResolvedValue(rows as never);
    db.privacyPolicy.findFirst.mockImplementation(((args: { where: { languageTag: { tag: string } } }) =>
      Promise.resolve(
        rows.find(({ languageTag }) => languageTag.tag === args.where.languageTag.tag) ?? null,
      )) as never);
  }

  /**
   * The language tags the server knows. The lock's query finds the row of each
   * by its bound tag, and nothing for any other.
   */
  function givenLanguageTags(client: MockDatabaseService, ...tags: string[]): void {
    client.$queryRaw.mockImplementation(((query: Prisma.Sql) => {
      const [tag] = query.values;
      return Promise.resolve(typeof tag === 'string' && tags.includes(tag) ? [{ id: `tag-${tag}` }] : []);
    }) as never);
  }

  /** Logs the transaction's commit, so a spec can place the emit after it. */
  const loggingCommit = (steps: string[]) =>
    db.$transaction.mockImplementation((async (operations: unknown) => {
      const result = await (operations as (tx: MockDatabaseService) => Promise<unknown>)(db);
      steps.push('commit');

      return result;
    }) as never);

  beforeEach(async () => {
    texts = new Map();
    emitter = { emit: jest.fn() };
    const files = {
      get: (language: string) => texts.get(language),
      languages: () => [...texts.keys()].sort(),
    } satisfies Pick<PrivacyPolicyFilesService, 'get' | 'languages'>;

    const ctx = await createTestingModuleWithDb({
      providers: [
        PrivacyPolicyService,
        { provide: PrivacyPolicyFilesService, useValue: files },
        { provide: EventEmitter2, useValue: emitter },
      ],
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

  // Anyone can read the policy, so a read lists the rows by language alone and
  // fetches the Markdown of the one row it serves, not every row's.
  it("reads the Markdown of the served language's row only", async () => {
    givenFiles(file('en'));
    givenRows(row('de'), row('fr'), row('pt-BR'));

    await service.read({ lang: 'fr' });

    expect(db.privacyPolicy.findMany).toHaveBeenCalledWith({ select: { languageTag: { select: { tag: true } } } });
    expect(db.privacyPolicy.findFirst).toHaveBeenCalledTimes(1);
    expect(db.privacyPolicy.findFirst).toHaveBeenCalledWith({
      where: { languageTag: { tag: 'fr' } },
      select: { markdown: true, updatedAt: true },
    });
  });

  it('reads no row when the served language has none', async () => {
    givenFiles(file('en'), file('de'));
    givenRows(row('fr'));

    await service.read({ lang: 'de' });

    expect(db.privacyPolicy.findFirst).not.toHaveBeenCalled();
  });

  // A server admin may remove the row between the listing and the row's read.
  it('serves the file when the row is removed between the two reads', async () => {
    givenFiles(file('en'), file('de'));
    givenRows(row('de'));
    db.privacyPolicy.findFirst.mockResolvedValueOnce(null);

    await expect(service.read({ lang: 'de' })).resolves.toMatchObject({ language: 'de', markdown: '# de file\n' });
  });

  it('chooses again when the removed row was the only text in its language', async () => {
    givenFiles(file('en'));
    db.privacyPolicy.findMany.mockResolvedValueOnce([row('pt-BR')] as never).mockResolvedValue([] as never);
    db.privacyPolicy.findFirst.mockResolvedValue(null);

    await expect(service.read({ lang: 'pt-BR' })).resolves.toMatchObject({
      availableLanguages: ['en'],
      language: 'en',
      markdown: '# en file\n',
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

  // A signed-in reader's stored language sits between lang and
  // Accept-Language, so a client needn't send it (#934).
  it("tries the reader's stored language after lang and before Accept-Language", async () => {
    givenFiles(file('en'), file('de'), file('fr'));

    const languageFor = async (input: PrivacyPolicyLanguageRequest) => (await service.read(input)).language;

    expect(await languageFor({ lang: 'fr', storedLanguage: 'de', acceptLanguage: 'en' })).toBe('fr');
    expect(await languageFor({ storedLanguage: 'de-AT', acceptLanguage: 'fr' })).toBe('de');
    expect(await languageFor({ storedLanguage: 'es', acceptLanguage: 'fr' })).toBe('fr');
    expect(await languageFor({ storedLanguage: null, acceptLanguage: 'fr' })).toBe('fr');
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

  // A tag the policy has, followed by subtags that aren't a tag's, is not a
  // language tag, so it falls through to Accept-Language rather than being
  // cut back to the language it starts with.
  it('passes over a lang or Accept-Language range that is not a tag, rather than cutting it back to its language', async () => {
    givenFiles(file('en'), file('de'), file('fr'));

    expect((await service.read({ lang: 'de-@@', acceptLanguage: 'fr' })).language).toBe('fr');
    expect((await service.read({ acceptLanguage: 'de-@@, fr;q=0.5' })).language).toBe('fr');
    expect((await service.read({ lang: 'de-AT', acceptLanguage: 'fr' })).language).toBe('de');
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

  describe('put', () => {
    beforeEach(() => {
      unwrapTransaction(db);
      givenFiles(file('en'));
      givenLanguageTags(db, 'de', 'en', 'en-US');
      db.privacyPolicy.findUnique.mockResolvedValue(null);
      db.privacyPolicy.upsert.mockImplementation(((args: {
        update: { markdown: string };
        where: { languageTagId: string };
      }) => Promise.resolve(snapshot(args.where.languageTagId, args.update.markdown))) as never);
    });

    it('stores the sanitized Markdown', async () => {
      const policy = await service.put('de', '# Datenschutz\n\nLies [das hier](javascript:alert(1)) und <b>x</b>.');
      const sanitized = '# Datenschutz\n\nLies das hier und x.';

      expect(db.privacyPolicy.upsert).toHaveBeenCalledWith({
        where: { languageTagId: 'tag-de' },
        create: { languageTagId: 'tag-de', markdown: sanitized },
        update: { markdown: sanitized },
        select: SNAPSHOT_SELECT,
      });
      expect(policy.markdown).toBe(sanitized);
    });

    it('refuses Markdown that sanitizes to nothing', async () => {
      for (const markdown of ['', ' \n\t\n', '<b></b>', '<div>\n</div>']) {
        await expect(service.put('de', markdown)).rejects.toMatchObject(
          refusal(HttpStatus.BAD_REQUEST, PrivacyPolicyErrorCode.Empty, 'errors.privacy_policy.empty'),
        );
      }

      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.privacyPolicy.upsert).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // The request's validation counts a character outside the Basic
    // Multilingual Plane once, and the sanitizer's bound counts it twice, so
    // this passes the DTO. Stored, the sanitizer would keep it as plain text
    // and flatten its headings and lists.
    it('refuses Markdown past the limit in UTF-16 code units, emoji counting as two', async () => {
      const markdown = '\u{1F600}'.repeat(PRIVACY_POLICY_MAX_LENGTH / 2 + 1);

      await expect(service.put('de', markdown)).rejects.toMatchObject(
        refusal(HttpStatus.BAD_REQUEST, PrivacyPolicyErrorCode.TooLong, 'errors.privacy_policy.too_long', {
          max: PRIVACY_POLICY_MAX_LENGTH,
        }),
      );

      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.privacyPolicy.upsert).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // The length is checked before sanitizing. Sanitized first, this text,
    // past the sanitizer's bound, would be kept as plain text, shrink under
    // the limit as its trailing newlines go, and be stored with its heading
    // flattened.
    it('refuses Markdown past the limit before sanitizing it', async () => {
      const padded = `# Datenschutz\n\n${'a'.repeat(PRIVACY_POLICY_MAX_LENGTH - 100)}${'\n'.repeat(200)}`;

      await expect(service.put('de', padded)).rejects.toMatchObject(
        refusal(HttpStatus.BAD_REQUEST, PrivacyPolicyErrorCode.TooLong, 'errors.privacy_policy.too_long', {
          max: PRIVACY_POLICY_MAX_LENGTH,
        }),
      );

      expect(db.privacyPolicy.upsert).not.toHaveBeenCalled();
    });

    // Within the limit, Markdown with more runs of emphasis markers than the
    // sanitizer parses would be stored as plain text with its headings and
    // lists flattened, so it is refused instead.
    it('refuses Markdown with too many runs of emphasis markers to keep its structure', async () => {
      const markdown = `# Datenschutz\n\n${'*a* '.repeat(1001)}`;

      await expect(service.put('de', markdown)).rejects.toMatchObject(
        refusal(HttpStatus.BAD_REQUEST, PrivacyPolicyErrorCode.TooComplex, 'errors.privacy_policy.too_complex'),
      );

      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.privacyPolicy.upsert).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('accepts Markdown at the limit', async () => {
      await service.put('de', 'a'.repeat(PRIVACY_POLICY_MAX_LENGTH));

      expect(db.privacyPolicy.upsert).toHaveBeenCalledTimes(1);
    });

    it('refuses a language tag the server does not know', async () => {
      // A language tag the server has no row for, and text that is no tag at all.
      for (const [languageTag, named] of [
        ['fr', 'fr'],
        ['FR-ca', 'fr-CA'],
        ['@@', '@@'],
      ]) {
        await expect(service.put(languageTag, '# Politique')).rejects.toMatchObject(
          refusal(
            HttpStatus.NOT_FOUND,
            PrivacyPolicyErrorCode.LanguageTagNotFound,
            'errors.privacy_policy.language_tag_not_found',
            { languageTag: named },
          ),
        );
      }

      expect(db.privacyPolicy.upsert).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();

      // It canonicalizes first, so EN-us finds the tag stored as en-US.
      await expect(service.put('EN-us', '# Policy')).resolves.toMatchObject({ language: 'en-US' });
      expect(db.privacyPolicy.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { languageTagId: 'tag-en-US' } }),
      );
    });

    it('creates, then replaces, the row for a language', async () => {
      await service.put('de', '# Erste Fassung');

      db.privacyPolicy.findUnique.mockResolvedValue(snapshot('tag-de', '# Erste Fassung') as never);
      await service.put('de', '# Zweite Fassung');

      expect(db.privacyPolicy.upsert.mock.calls).toEqual([
        [
          {
            where: { languageTagId: 'tag-de' },
            create: { languageTagId: 'tag-de', markdown: '# Erste Fassung' },
            update: { markdown: '# Erste Fassung' },
            select: SNAPSHOT_SELECT,
          },
        ],
        [
          {
            where: { languageTagId: 'tag-de' },
            create: { languageTagId: 'tag-de', markdown: '# Zweite Fassung' },
            update: { markdown: '# Zweite Fassung' },
            select: SNAPSHOT_SELECT,
          },
        ],
      ]);
      expect(db.privacyPolicy.findUnique).toHaveBeenCalledWith({
        where: { languageTagId: 'tag-de' },
        select: SNAPSHOT_SELECT,
      });
    });

    it('answers the policy as now served in the language, with the languages recomputed', async () => {
      givenFiles(file('en'), file('fr'));
      givenRows(row('de'), row('pt-BR'));

      await expect(service.put('de', '# Neu')).resolves.toEqual({
        availableLanguages: ['de', 'en', 'fr', 'pt-BR'],
        language: 'de',
        markdown: '# Neu',
        source: 'operator',
        updatedAt: WRITTEN_AT.toISOString(),
      });
    });

    // The languages are read after the write, so a first write in a language
    // lists that language in its own answer.
    it("lists a first write's language in its own answer", async () => {
      givenFiles(file('en'));
      givenLanguageTags(db, 'pt-BR');
      const stored: ReturnType<typeof row>[] = [];
      db.privacyPolicy.findMany.mockImplementation((() => Promise.resolve([...stored])) as never);
      db.privacyPolicy.upsert.mockImplementation((() => {
        stored.push(row('pt-BR'));
        return Promise.resolve(snapshot('tag-pt-BR', '# Política'));
      }) as never);

      await expect(service.put('pt-BR', '# Política')).resolves.toMatchObject({
        availableLanguages: ['en', 'pt-BR'],
        language: 'pt-BR',
      });
    });

    // Sending the stored text again changes nothing a reader sees, so its
    // date stays and nothing is audited: a client compares the date to tell
    // the reader the policy changed (client#593).
    it('leaves the row, its date and the audit trail alone when the sanitized text is the stored text', async () => {
      const storedAt = new Date('2026-12-01T10:20:30.000Z');
      const stored = snapshot('tag-de', '# Datenschutz\n\nLies das hier und x.', storedAt);
      db.privacyPolicy.findUnique.mockResolvedValue(stored as never);
      givenFiles(file('en'));
      givenRows(row('de'));

      await expect(
        service.put('de', '# Datenschutz\n\nLies [das hier](javascript:alert(1)) und <b>x</b>.'),
      ).resolves.toEqual({
        availableLanguages: ['de', 'en'],
        language: 'de',
        markdown: '# Datenschutz\n\nLies das hier und x.',
        source: 'operator',
        updatedAt: storedAt.toISOString(),
      });

      expect(db.privacyPolicy.upsert).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // A policy file's CRLF line endings are read as LF, and so are a server
    // admin's: the same text sent from Windows changes nothing a reader sees.
    it('stores CRLF line endings as LF, so resending the stored text with CRLF changes nothing', async () => {
      await service.put('de', '# Datenschutz\r\n\r\nText.\r\n');

      expect(db.privacyPolicy.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { markdown: '# Datenschutz\n\nText.\n' } }),
      );

      db.privacyPolicy.upsert.mockClear();
      emitter.emit.mockClear();
      db.privacyPolicy.findUnique.mockResolvedValue(snapshot('tag-de', '# Datenschutz\n\nText.\n') as never);
      givenRows(row('de'));

      await service.put('de', '# Datenschutz\r\n\r\nText.\r\n');

      expect(db.privacyPolicy.upsert).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('emits a replaced event after the write, with the earlier text as before', async () => {
      const steps: string[] = [];
      loggingCommit(steps);
      const earlier = snapshot('tag-de', '# Alt', new Date('2026-12-01T10:20:30.000Z'));
      db.privacyPolicy.findUnique.mockResolvedValue(earlier as never);
      db.privacyPolicy.upsert.mockImplementation((() => {
        steps.push('write');
        return Promise.resolve(snapshot('tag-de', '# Neu'));
      }) as never);
      emitter.emit.mockImplementation(() => steps.push('emit'));

      await service.put('de', '# Neu');

      expect(steps).toEqual(['write', 'commit', 'emit']);
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(PrivacyPolicyEvents.Replaced, expect.any(PrivacyPolicyReplacedEvent));

      const event = emitter.emit.mock.calls[0]?.[1] as PrivacyPolicyReplacedEvent;
      expect(event).toMatchObject({ subject: ResourceType.PrivacyPolicy, subjectId: 'policy-tag-de' });
      expect(event.before).toEqual(earlier);
      expect(event.after).toEqual(snapshot('tag-de', '# Neu'));
      expect(event.action).toBe('update');
    });

    it('emits the first write in a language as a create, with no before', async () => {
      await service.put('de', '# Neu');

      const event = emitter.emit.mock.calls[0]?.[1] as PrivacyPolicyReplacedEvent;
      expect(event.before).toBeNull();
      expect(event.after).toEqual(snapshot('tag-de', '# Neu'));
      expect(event.action).toBe('create');
    });

    it('emits nothing when the write fails', async () => {
      db.privacyPolicy.upsert.mockRejectedValue(new Error('connection reset'));

      await expect(service.put('de', '# Neu')).rejects.toThrow('connection reset');

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // Under READ COMMITTED two server admins writing one language at once would
    // both read the same earlier text, and the later write's event would name
    // a before it never replaced. The lock on the language tag's row makes
    // them take turns, so each reads the text it replaces.
    it("locks the language tag's row before reading the earlier text, in the write's own transaction", async () => {
      // A client of its own for the transaction, so a lock taken on the root
      // client cannot pass for one: that would be an autocommit statement,
      // released before the read it is meant to guard.
      const tx = createMockDatabaseService();
      db.$transaction.mockImplementation(((callback: (client: MockDatabaseService) => Promise<unknown>) =>
        callback(tx)) as never);
      const order: string[] = [];
      givenLanguageTags(tx, 'de');
      const lock = tx.$queryRaw.getMockImplementation();
      tx.$queryRaw.mockImplementation(((query: Prisma.Sql) => {
        order.push(rawQueryText(query));
        return lock?.(query);
      }) as never);
      tx.privacyPolicy.findUnique.mockImplementation((() => {
        order.push('read');
        return Promise.resolve(null);
      }) as never);
      tx.privacyPolicy.upsert.mockImplementation((() => {
        order.push('write');
        return Promise.resolve(snapshot('tag-de', '# Neu'));
      }) as never);
      tx.privacyPolicy.findMany.mockImplementation((() => {
        order.push('languages');
        return Promise.resolve([]);
      }) as never);

      await service.put('DE', '# Neu');

      // The languages for the answer are read last, so they include the write.
      expect(order).toEqual([LANGUAGE_TAG_LOCK, 'read', 'write', 'languages']);
      expect((tx.$queryRaw.mock.calls[0]?.[0] as Prisma.Sql).values).toEqual(['de']);
      expect(db.$transaction).toHaveBeenCalledTimes(1);
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.privacyPolicy.findUnique).not.toHaveBeenCalled();
      expect(db.privacyPolicy.upsert).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    beforeEach(() => {
      unwrapTransaction(db);
      givenLanguageTags(db, 'de', 'en');
      db.privacyPolicy.delete.mockResolvedValue(snapshot('tag-de', '# Alt') as never);
    });

    it('removes the row and emits a removed event', async () => {
      const steps: string[] = [];
      loggingCommit(steps);
      db.privacyPolicy.delete.mockImplementation((() => {
        steps.push('delete');
        return Promise.resolve(snapshot('tag-de', '# Alt'));
      }) as never);
      emitter.emit.mockImplementation(() => steps.push('emit'));

      await expect(service.remove('DE')).resolves.toBeUndefined();

      expect(db.privacyPolicy.delete).toHaveBeenCalledWith({
        where: { languageTagId: 'tag-de' },
        select: SNAPSHOT_SELECT,
      });
      expect(steps).toEqual(['delete', 'commit', 'emit']);
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(PrivacyPolicyEvents.Removed, expect.any(PrivacyPolicyRemovedEvent));

      const event = emitter.emit.mock.calls[0]?.[1] as PrivacyPolicyRemovedEvent;
      expect(event).toMatchObject({ subject: ResourceType.PrivacyPolicy, subjectId: 'policy-tag-de', after: null });
      expect(event.before).toEqual(snapshot('tag-de', '# Alt'));
      expect(event.action).toBe('delete');
    });

    it('answers 404 PRIVACY_POLICY_NOT_FOUND when there is no row to remove', async () => {
      db.privacyPolicy.delete.mockRejectedValue(recordNotFound());

      await expect(service.remove('de')).rejects.toMatchObject(
        refusal(HttpStatus.NOT_FOUND, PrivacyPolicyErrorCode.NotFound, 'errors.privacy_policy.not_found', {
          languageTag: 'de',
        }),
      );

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // There is nothing to remove whether or not the server knows the language,
    // so the answer is the same; an unknown language is PUT's refusal.
    it('answers 404 PRIVACY_POLICY_NOT_FOUND for a language the server does not know, too', async () => {
      for (const [languageTag, named] of [
        ['fr', 'fr'],
        ['FR-ca', 'fr-CA'],
        ['@@', '@@'],
      ]) {
        await expect(service.remove(languageTag)).rejects.toMatchObject(
          refusal(HttpStatus.NOT_FOUND, PrivacyPolicyErrorCode.NotFound, 'errors.privacy_policy.not_found', {
            languageTag: named,
          }),
        );
      }

      expect(db.privacyPolicy.delete).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('emits nothing when the delete fails', async () => {
      db.privacyPolicy.delete.mockRejectedValue(new Error('connection reset'));

      await expect(service.remove('de')).rejects.toThrow('connection reset');

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // The lock PUT takes, so a write and a removal in one language take turns:
    // a write never reads, as its before, a row a removal is deleting.
    it("locks the language tag's row before the delete, in the delete's own transaction", async () => {
      const tx = createMockDatabaseService();
      db.$transaction.mockImplementation(((callback: (client: MockDatabaseService) => Promise<unknown>) =>
        callback(tx)) as never);
      const order: string[] = [];
      givenLanguageTags(tx, 'de');
      const lock = tx.$queryRaw.getMockImplementation();
      tx.$queryRaw.mockImplementation(((query: Prisma.Sql) => {
        order.push(rawQueryText(query));
        return lock?.(query);
      }) as never);
      tx.privacyPolicy.delete.mockImplementation((() => {
        order.push('delete');
        return Promise.resolve(snapshot('tag-de', '# Alt'));
      }) as never);

      await service.remove('de');

      expect(order).toEqual([LANGUAGE_TAG_LOCK, 'delete']);
      expect((tx.$queryRaw.mock.calls[0]?.[0] as Prisma.Sql).values).toEqual(['de']);
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.privacyPolicy.delete).not.toHaveBeenCalled();
    });
  });
});
