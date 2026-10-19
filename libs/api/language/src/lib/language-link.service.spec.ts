import { LanguageCodeFormat, LanguageLinkStatus, LanguageTagSource } from '@bge/database';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { LanguageLinkService } from './language-link.service';

describe('LanguageLinkService', () => {
  let service: LanguageLinkService;
  let db: MockDatabaseService;

  beforeEach(async () => {
    const testing = await createTestingModuleWithDb({
      providers: [LanguageLinkService],
    });

    db = testing.db;
    service = testing.module.get(LanguageLinkService);

    // Defaults: review off, no existing links/tags/languages, writes succeed.
    db.systemSetting.findFirst.mockResolvedValue({ reviewGatewayLanguages: false } as never);
    db.languageGatewayLink.findUnique.mockResolvedValue(null);
    // As Prisma answers a create: the row as written.
    db.languageGatewayLink.upsert.mockImplementation((async (args: {
      create: { status: LanguageLinkStatus; tagId: string | null };
    }) => ({ status: args.create.status, tagId: args.create.tagId })) as never);
    db.languageGatewayLink.updateMany.mockResolvedValue({ count: 1 } as never);
    db.languageTag.findUnique.mockResolvedValue(null);
    db.languageTag.findFirst.mockResolvedValue(null);
    db.language.findUnique.mockResolvedValue(null);
    db.language.findFirst.mockResolvedValue(null);
  });

  afterEach(() => jest.clearAllMocks());

  const GW = 'gw-test';

  describe('resolveLanguageData', () => {
    it('consults the most specific candidate first (ietf_tag wins)', async () => {
      db.languageGatewayLink.findUnique.mockResolvedValueOnce({
        status: LanguageLinkStatus.Resolved,
        tagId: 'tag-zh-hant',
      } as never);

      const tagId = await service.resolveLanguageData(GW, {
        ietfTag: 'zh-Hant',
        iso6393: 'zho',
        name: 'Chinese (Traditional)',
      });

      expect(tagId).toBe('tag-zh-hant');
      expect(db.languageGatewayLink.findUnique).toHaveBeenCalledTimes(1);
      expect(db.languageGatewayLink.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            gatewayId_value_format: { gatewayId: GW, value: 'zh-Hant', format: LanguageCodeFormat.IetfBcp47 },
          },
        }),
      );
    });

    it('returns null for a pending link without falling through to weaker candidates', async () => {
      db.languageGatewayLink.findUnique.mockResolvedValueOnce({
        status: LanguageLinkStatus.Pending,
        tagId: null,
      } as never);

      const tagId = await service.resolveLanguageData(GW, { ietfTag: 'kk', iso6393: 'kaz', name: 'Kazakh' });

      expect(tagId).toBeNull();
      expect(db.languageGatewayLink.findUnique).toHaveBeenCalledTimes(1);
    });

    it('resolves a new valid tag against the existing vocabulary and persists an Import link', async () => {
      db.languageTag.findUnique.mockResolvedValue({ id: 'tag-en-us' } as never);

      const tagId = await service.resolveLanguageData(GW, { ietfTag: 'en-US', iso6393: 'eng', name: 'English (US)' });

      expect(tagId).toBe('tag-en-us');
      expect(db.languageGatewayLink.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            gatewayId: GW,
            value: 'en-US',
            format: LanguageCodeFormat.IetfBcp47,
            origin: 'Import',
            status: LanguageLinkStatus.Resolved,
            tagId: 'tag-en-us',
          }),
        }),
      );
    });

    it('normalizes structured candidate casing so variants reuse one link row', async () => {
      db.languageTag.findUnique.mockResolvedValue({ id: 'tag-en-us' } as never);

      const tagId = await service.resolveLanguageData(GW, { ietfTag: 'EN-us' });

      expect(tagId).toBe('tag-en-us');
      // The gateway's casing 'EN-us' collapses to canonical 'en-US' for both
      // the lookup key and the persisted row, so casing variants can't spawn
      // duplicate links for the same tag.
      expect(db.languageGatewayLink.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            gatewayId_value_format: { gatewayId: GW, value: 'en-US', format: LanguageCodeFormat.IetfBcp47 },
          },
        }),
      );
      expect(db.languageGatewayLink.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ value: 'en-US', format: LanguageCodeFormat.IetfBcp47 }),
        }),
      );
    });

    it('returns null when nothing is provided', async () => {
      await expect(service.resolveLanguageData(GW, {})).resolves.toBeNull();
    });
  });

  describe('interview — structured (BCP 47) entries', () => {
    const entry = {
      value: 'kk',
      format: LanguageCodeFormat.IetfBcp47,
      ietfTag: 'kk',
      name: 'Kazakh',
    };

    it('auto-adds the language and tag when review is off', async () => {
      db.language.upsert.mockResolvedValue({ id: 'lang-kaz' } as never);
      db.languageTag.upsert.mockResolvedValue({ id: 'tag-kk' } as never);

      const summary = await service.interview(GW, [entry]);

      expect(summary).toEqual({ resolved: 1, pending: 0, unresolved: 0, ignored: 0 });
      // Auto-add upserts (not creates) so concurrent workers can't collide on
      // the unique iso6393 / tag keys.
      expect(db.language.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { iso6393: 'kaz' },
          create: expect.objectContaining({ iso6393: 'kaz', iso6391: 'kk', name: 'Kazakh' }),
        }),
      );
      expect(db.languageTag.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tag: 'kk' },
          create: expect.objectContaining({ tag: 'kk', source: LanguageTagSource.Gateway, languageId: 'lang-kaz' }),
        }),
      );
    });

    it('parks the entry as Pending when review is on', async () => {
      db.systemSetting.findFirst.mockResolvedValue({ reviewGatewayLanguages: true } as never);

      const summary = await service.interview(GW, [entry]);

      expect(summary).toEqual({ resolved: 0, pending: 1, unresolved: 0, ignored: 0 });
      expect(db.language.upsert).not.toHaveBeenCalled();
      expect(db.languageTag.upsert).not.toHaveBeenCalled();
      expect(db.languageGatewayLink.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: LanguageLinkStatus.Pending, tagId: null }),
        }),
      );
    });

    it('marks syntactically valid but unregistered subtags Unresolved', async () => {
      const summary = await service.interview(GW, [{ value: 'xq-XX', format: LanguageCodeFormat.IetfBcp47 }]);

      expect(summary.unresolved).toBe(1);
      expect(db.language.upsert).not.toHaveBeenCalled();
    });
  });

  describe('interview — free-text (NAME) entries', () => {
    it('resolves by tag display name, case-insensitively', async () => {
      db.languageTag.findFirst.mockResolvedValue({ id: 'tag-cs' } as never);

      const summary = await service.interview(GW, [{ value: 'czech', format: LanguageCodeFormat.Name }]);

      expect(summary.resolved).toBe(1);
      expect(db.languageGatewayLink.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ tagId: 'tag-cs', status: LanguageLinkStatus.Resolved }),
        }),
      );
    });

    it('falls back to the language name and lands on its bare tag', async () => {
      db.language.findFirst.mockResolvedValue({ id: 'lang-deu', iso6391: 'de', iso6393: 'deu' } as never);
      db.languageTag.findUnique.mockResolvedValue({ id: 'tag-de' } as never);

      const summary = await service.interview(GW, [{ value: 'German', format: LanguageCodeFormat.Name }]);

      expect(summary.resolved).toBe(1);
      expect(db.languageTag.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tag: 'de' } }));
    });

    it('quarantines unknown names as Unresolved and never creates vocabulary', async () => {
      const summary = await service.interview(GW, [{ value: 'Klingon', format: LanguageCodeFormat.Name }]);

      expect(summary).toEqual({ resolved: 0, pending: 0, unresolved: 1, ignored: 0 });
      expect(db.language.upsert).not.toHaveBeenCalled();
      expect(db.languageTag.upsert).not.toHaveBeenCalled();
      expect(db.languageGatewayLink.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: LanguageLinkStatus.Unresolved, tagId: null }),
        }),
      );
    });

    it('resolves NAME entries with ISO enrichments through the structured path', async () => {
      // BGG interview entries carry hand-curated ISO codes.
      db.languageTag.findUnique.mockResolvedValue({ id: 'tag-cs' } as never);
      db.language.findUnique.mockResolvedValue({ id: 'lang-ces' } as never);

      const summary = await service.interview(GW, [
        { value: 'Czech', format: LanguageCodeFormat.Name, iso6393: 'ces', iso6391: 'cs', name: 'Czech' },
      ]);

      expect(summary.resolved).toBe(1);
      // Resolved via the bare tag ('cs'), not via free-text name matching.
      expect(db.languageTag.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tag: 'cs' } }));
      expect(db.languageTag.findFirst).not.toHaveBeenCalled();
    });

    it('matches ISO enrichments case-insensitively against the registry', async () => {
      db.languageTag.findUnique.mockResolvedValue({ id: 'tag-cs' } as never);

      // A gateway sending uppercase ISO codes must still resolve, not park
      // as Unresolved because 'CES' != registry's lowercase 'ces'.
      const summary = await service.interview(GW, [
        { value: 'Czech', format: LanguageCodeFormat.Name, iso6393: 'CES', iso6391: 'CS' },
      ]);

      expect(summary.resolved).toBe(1);
      expect(db.languageTag.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tag: 'cs' } }));
    });

    it('collapses free-text whitespace so padded names reuse one link row', async () => {
      db.languageTag.findFirst.mockResolvedValue({ id: 'tag-de' } as never);

      await service.interview(GW, [{ value: '  German ', format: LanguageCodeFormat.Name }]);

      expect(db.languageGatewayLink.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { gatewayId_value_format: { gatewayId: GW, value: 'German', format: LanguageCodeFormat.Name } },
          create: expect.objectContaining({ value: 'German' }),
        }),
      );
    });
  });

  describe('interview — existing links', () => {
    it('leaves Resolved and Ignored links untouched', async () => {
      db.languageGatewayLink.findUnique
        .mockResolvedValueOnce({ status: LanguageLinkStatus.Resolved, tagId: 'tag-1' } as never)
        .mockResolvedValueOnce({ status: LanguageLinkStatus.Ignored, tagId: null } as never);

      const summary = await service.interview(GW, [
        { value: 'en', format: LanguageCodeFormat.IetfBcp47 },
        { value: 'Neutral', format: LanguageCodeFormat.Name },
      ]);

      expect(summary).toEqual({ resolved: 1, pending: 0, unresolved: 0, ignored: 1 });
      expect(db.languageGatewayLink.upsert).not.toHaveBeenCalled();
    });

    it('re-attempts resolution for previously Unresolved links', async () => {
      db.languageGatewayLink.findUnique.mockResolvedValue({
        status: LanguageLinkStatus.Unresolved,
        tagId: null,
      } as never);
      db.languageTag.findFirst.mockResolvedValue({ id: 'tag-cs' } as never);

      const summary = await service.interview(GW, [{ value: 'Czech', format: LanguageCodeFormat.Name }]);

      expect(summary.resolved).toBe(1);
    });

    // #715: an admin may link or ignore an Unresolved link while an interview
    // re-resolves the same value. The interview's write applies only while
    // the link is still Unresolved, so the admin's decision survives.
    it('writes a re-resolved link only while it is still Unresolved', async () => {
      db.languageGatewayLink.findUnique.mockResolvedValue({
        status: LanguageLinkStatus.Unresolved,
        tagId: null,
      } as never);
      db.languageTag.findFirst.mockResolvedValue({ id: 'tag-cs' } as never);

      await service.interview(GW, [{ value: 'Czech', format: LanguageCodeFormat.Name }]);

      expect(db.languageGatewayLink.upsert).not.toHaveBeenCalled();
      expect(db.languageGatewayLink.updateMany).toHaveBeenCalledWith({
        where: {
          gatewayId: GW,
          value: 'Czech',
          format: LanguageCodeFormat.Name,
          status: LanguageLinkStatus.Unresolved,
        },
        data: expect.objectContaining({ status: LanguageLinkStatus.Resolved, tagId: 'tag-cs' }),
      });
    });

    it("counts the admin's decision when the link was settled meanwhile", async () => {
      db.languageGatewayLink.findUnique
        .mockResolvedValueOnce({ status: LanguageLinkStatus.Unresolved, tagId: null } as never)
        .mockResolvedValueOnce({ status: LanguageLinkStatus.Ignored, tagId: null } as never);
      db.languageTag.findFirst.mockResolvedValue({ id: 'tag-cs' } as never);
      db.languageGatewayLink.updateMany.mockResolvedValue({ count: 0 } as never);

      const summary = await service.interview(GW, [{ value: 'Czech', format: LanguageCodeFormat.Name }]);

      expect(summary).toEqual({ resolved: 0, pending: 0, unresolved: 0, ignored: 1 });
    });

    it('creates a value it has never seen, and overwrites nothing if the row appeared meanwhile', async () => {
      db.languageTag.findFirst.mockResolvedValue({ id: 'tag-cs' } as never);

      await service.interview(GW, [{ value: 'Czech', format: LanguageCodeFormat.Name }]);

      expect(db.languageGatewayLink.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
      expect(db.languageGatewayLink.updateMany).not.toHaveBeenCalled();
    });

    // An import may create the link while this interview resolves it, and an
    // admin may settle it before the interview writes.
    it("keeps an admin's decision on a link another writer created meanwhile", async () => {
      db.languageTag.findFirst.mockResolvedValue({ id: 'tag-cs' } as never);
      db.languageGatewayLink.upsert.mockResolvedValue({ status: LanguageLinkStatus.Ignored, tagId: null } as never);

      const summary = await service.interview(GW, [{ value: 'Czech', format: LanguageCodeFormat.Name }]);

      expect(summary).toEqual({ resolved: 0, pending: 0, unresolved: 0, ignored: 1 });
      expect(db.languageGatewayLink.updateMany).not.toHaveBeenCalled();
    });

    it('settles a link another writer created Unresolved meanwhile, while it is still Unresolved', async () => {
      db.languageTag.findFirst.mockResolvedValue({ id: 'tag-cs' } as never);
      db.languageGatewayLink.upsert.mockResolvedValue({ status: LanguageLinkStatus.Unresolved, tagId: null } as never);

      const summary = await service.interview(GW, [{ value: 'Czech', format: LanguageCodeFormat.Name }]);

      expect(summary.resolved).toBe(1);
      expect(db.languageGatewayLink.updateMany).toHaveBeenCalledWith({
        where: {
          gatewayId: GW,
          value: 'Czech',
          format: LanguageCodeFormat.Name,
          status: LanguageLinkStatus.Unresolved,
        },
        data: expect.objectContaining({ status: LanguageLinkStatus.Resolved, tagId: 'tag-cs' }),
      });
    });
  });

  // The supplied tag is kept with the others, so a Pending link can be
  // resolved later as the DataGateway meant it (#715).
  describe('interview — supplied metadata', () => {
    it('keeps the supplied BCP 47 tag beside the ISO codes and names', async () => {
      db.systemSetting.findFirst.mockResolvedValue({ reviewGatewayLanguages: true } as never);

      await service.interview(GW, [
        { value: 'zho', format: LanguageCodeFormat.Iso6393, ietfTag: 'zh-Hant', name: 'Chinese (Traditional)' },
      ]);

      expect(db.languageGatewayLink.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: LanguageLinkStatus.Pending,
            suppliedIetfTag: 'zh-Hant',
            suppliedIso6393: null,
            suppliedName: 'Chinese (Traditional)',
          }),
        }),
      );
    });
  });

  // #715: an admin accepts a Pending link, which settles it as the
  // unknown-language policy would have without review.
  describe('acceptPending', () => {
    const pending = {
      id: 'link-1',
      gatewayId: GW,
      value: 'pt-BR',
      format: LanguageCodeFormat.IetfBcp47,
      status: LanguageLinkStatus.Pending,
      suppliedIetfTag: 'pt-BR',
      suppliedIso6393: null,
      suppliedIso6391: null,
      suppliedName: 'Portuguese (Brazil)',
      suppliedNativeName: null,
    };

    beforeEach(() => {
      db.systemSetting.findFirst.mockResolvedValue({ reviewGatewayLanguages: true } as never);
      db.language.upsert.mockResolvedValue({ id: 'lang-por' } as never);
      db.languageTag.upsert.mockResolvedValue({ id: 'tag-pt-br' } as never);
    });

    it('adds the language and tag with review on, and resolves the link to the tag', async () => {
      db.languageGatewayLink.findUnique.mockResolvedValue(pending as never);

      await expect(service.acceptPending('link-1')).resolves.toEqual({ accepted: true, tagId: 'tag-pt-br' });

      expect(db.language.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { iso6393: 'por' } }));
      expect(db.languageTag.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tag: 'pt-BR' },
          create: expect.objectContaining({ source: LanguageTagSource.Gateway }),
        }),
      );
      expect(db.languageGatewayLink.updateMany).toHaveBeenCalledWith({
        where: { id: 'link-1', status: LanguageLinkStatus.Pending },
        data: { status: LanguageLinkStatus.Resolved, tagId: 'tag-pt-br' },
      });
    });

    it('resolves to the tag when it exists by now, and adds nothing', async () => {
      db.languageGatewayLink.findUnique.mockResolvedValue(pending as never);
      db.languageTag.findUnique.mockResolvedValue({ id: 'tag-pt-br-existing' } as never);

      await expect(service.acceptPending('link-1')).resolves.toEqual({
        accepted: true,
        tagId: 'tag-pt-br-existing',
      });
      expect(db.language.upsert).not.toHaveBeenCalled();
      expect(db.languageTag.upsert).not.toHaveBeenCalled();
    });

    it('resolves an ISO value to the tag the DataGateway supplied beside it', async () => {
      db.languageGatewayLink.findUnique.mockResolvedValue({
        ...pending,
        value: 'zho',
        format: LanguageCodeFormat.Iso6393,
        suppliedIetfTag: 'zh-Hant',
      } as never);
      db.languageTag.findUnique.mockImplementation((async (args: { where: { tag: string } }) =>
        args.where.tag === 'zh-Hant' ? { id: 'tag-zh-hant' } : { id: 'tag-zh' }) as never);

      await expect(service.acceptPending('link-1')).resolves.toEqual({ accepted: true, tagId: 'tag-zh-hant' });
    });

    it.each([[LanguageLinkStatus.Resolved], [LanguageLinkStatus.Unresolved], [LanguageLinkStatus.Ignored]])(
      'refuses a link that is %s, and writes nothing',
      async (status) => {
        db.languageGatewayLink.findUnique.mockResolvedValue({ ...pending, status } as never);

        await expect(service.acceptPending('link-1')).resolves.toEqual({ accepted: false, reason: 'not_pending' });
        expect(db.languageGatewayLink.updateMany).not.toHaveBeenCalled();
        expect(db.languageTag.upsert).not.toHaveBeenCalled();
      },
    );

    it('refuses a link that no longer exists', async () => {
      await expect(service.acceptPending('link-1')).resolves.toEqual({ accepted: false, reason: 'not_pending' });
    });

    it('refuses a link settled between the read and the write', async () => {
      db.languageGatewayLink.findUnique.mockResolvedValue(pending as never);
      db.languageGatewayLink.updateMany.mockResolvedValue({ count: 0 } as never);

      await expect(service.acceptPending('link-1')).resolves.toEqual({ accepted: false, reason: 'not_pending' });
    });

    it('refuses a link that names no registered language, and writes nothing', async () => {
      db.languageGatewayLink.findUnique.mockResolvedValue({
        ...pending,
        value: 'xq-XX',
        suppliedIetfTag: null,
      } as never);

      await expect(service.acceptPending('link-1')).resolves.toEqual({ accepted: false, reason: 'not_acceptable' });
      expect(db.languageGatewayLink.updateMany).not.toHaveBeenCalled();
      expect(db.language.upsert).not.toHaveBeenCalled();
    });
  });

  describe('interview — stopped', () => {
    it('links no further language once its signal aborts, and throws the reason', async () => {
      const stop = new AbortController();
      db.languageGatewayLink.upsert.mockImplementationOnce((async () => {
        stop.abort(new Error('abandoned'));
        return {};
      }) as never);

      await expect(
        service.interview(
          GW,
          [
            { value: 'Klingon', format: LanguageCodeFormat.Name },
            { value: 'Elvish', format: LanguageCodeFormat.Name },
          ],
          stop.signal,
        ),
      ).rejects.toThrow('abandoned');

      expect(db.languageGatewayLink.upsert).toHaveBeenCalledTimes(1);
    });

    it('writes no link for the language under way once its signal aborts', async () => {
      const stop = new AbortController();
      db.languageGatewayLink.findUnique.mockImplementationOnce((async () => {
        stop.abort(new Error('abandoned'));
        return null;
      }) as never);
      db.languageTag.findUnique.mockResolvedValue({ id: 'tag-en-us' } as never);

      await expect(
        service.interview(GW, [{ value: 'en-US', format: LanguageCodeFormat.IetfBcp47 }], stop.signal),
      ).rejects.toThrow('abandoned');

      expect(db.languageGatewayLink.upsert).not.toHaveBeenCalled();
    });

    it('settles no link another writer created meanwhile once its signal aborts', async () => {
      const stop = new AbortController();
      db.languageTag.findFirst.mockResolvedValue({ id: 'tag-cs' } as never);
      db.languageGatewayLink.upsert.mockImplementationOnce((async () => {
        stop.abort(new Error('abandoned'));
        return { status: LanguageLinkStatus.Unresolved, tagId: null };
      }) as never);

      await expect(
        service.interview(GW, [{ value: 'Czech', format: LanguageCodeFormat.Name }], stop.signal),
      ).rejects.toThrow('abandoned');

      expect(db.languageGatewayLink.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      ['a BCP 47 tag', { value: 'kk', format: LanguageCodeFormat.IetfBcp47 }],
      ['an ISO 639-3 code', { value: 'kaz', format: LanguageCodeFormat.Iso6393 }],
    ])('adds no vocabulary for %s under way once its signal aborts', async (_, entry) => {
      const stop = new AbortController();
      db.languageTag.findUnique.mockImplementationOnce((async () => {
        stop.abort(new Error('abandoned'));
        return null;
      }) as never);

      await expect(service.interview(GW, [entry], stop.signal)).rejects.toThrow('abandoned');

      expect(db.language.upsert).not.toHaveBeenCalled();
      expect(db.languageTag.upsert).not.toHaveBeenCalled();
      expect(db.languageGatewayLink.upsert).not.toHaveBeenCalled();
    });
  });
});
