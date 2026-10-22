import { DataGatewayCapability, DataGatewaySectionFailure, LanguageCodeFormat, PlatformType } from '@bge/database';
import { LanguageLinkService } from '@bge/language';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { VocabularyLinkService } from '@bge/vocabulary';
import { InMemoryGatewayDriver } from '@boardgamesempire/gateway-driver-contract-testing';
import * as proto from '@boardgamesempire/proto-gateway';
import { NEVER, Observable } from 'rxjs';
import { SECTION_LIST_TIMEOUT_MS } from './constants/vocabulary-section.constants';
import { VocabularySectionError } from './errors/vocabulary-section.error';
import { VocabularySectionService } from './vocabulary-section.service';

const GW = 'g1';
const { ListLanguages, ListPlatforms, ListCategories, ListMechanics } = DataGatewayCapability;

const ENGLISH: proto.GatewayLanguageEntry = {
  value: 'en-US',
  format: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47,
  ietfTag: 'en-US',
  iso6393: 'eng',
  iso6391: 'en',
  name: 'English (US)',
};

const PC: proto.PlatformData = {
  externalId: '6',
  name: 'PC (Microsoft Windows)',
  abbreviation: 'PC',
  platformType: proto.PlatformType.PLATFORM_TYPE_PC,
};

/** The section's failure, or what it threw when that isn't one. */
const failureOf = (load: Promise<void>) =>
  load.then(
    () => undefined,
    (error: unknown) => (error instanceof VocabularySectionError ? error.code : error),
  );

describe('VocabularySectionService', () => {
  let service: VocabularySectionService;
  let db: MockDatabaseService;
  let languageLinks: { interview: jest.Mock };
  let vocabulary: { load: jest.Mock };
  let signal: AbortSignal;

  beforeEach(async () => {
    languageLinks = { interview: jest.fn().mockResolvedValue({ resolved: 1, pending: 0, unresolved: 0, ignored: 0 }) };
    vocabulary = { load: jest.fn().mockResolvedValue({ created: 0, matched: 0, pending: 0, kept: 0 }) };

    const testing = await createTestingModuleWithDb({
      providers: [
        VocabularySectionService,
        { provide: LanguageLinkService, useValue: languageLinks },
        { provide: VocabularyLinkService, useValue: vocabulary },
      ],
    });

    db = testing.db;
    service = testing.module.get(VocabularySectionService);
    signal = new AbortController().signal;
  });

  afterEach(() => jest.clearAllMocks());

  describe('the language section', () => {
    it('links each language the DataGateway lists, in the server’s formats', async () => {
      await service.load(GW, ListLanguages, new InMemoryGatewayDriver({ languages: [ENGLISH] }), signal);

      expect(languageLinks.interview).toHaveBeenCalledWith(
        GW,
        [
          {
            value: 'en-US',
            format: LanguageCodeFormat.IetfBcp47,
            ietfTag: 'en-US',
            iso6393: 'eng',
            iso6391: 'en',
            name: 'English (US)',
            nativeName: undefined,
          },
        ],
        signal,
      );
    });

    it('leaves out a listed language it can’t read, and links the rest', async () => {
      const blank: proto.GatewayLanguageEntry = { ...ENGLISH, value: '  ' };
      const unknownFormat: proto.GatewayLanguageEntry = {
        ...ENGLISH,
        value: 'xx',
        format: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_UNSPECIFIED,
      };
      const driver = new InMemoryGatewayDriver({ languages: [blank, unknownFormat, ENGLISH] });

      await service.load(GW, ListLanguages, driver, signal);

      expect(languageLinks.interview).toHaveBeenCalledWith(GW, [expect.objectContaining({ value: 'en-US' })], signal);
    });
  });

  describe('the vocabulary sections', () => {
    it('links each platform the DataGateway lists, with its stored platform type', async () => {
      const unclassified = {
        ...PC,
        externalId: '99',
        name: 'Odd',
        platformType: proto.PlatformType.PLATFORM_TYPE_UNSPECIFIED,
      };

      await service.load(GW, ListPlatforms, new InMemoryGatewayDriver({ platforms: [PC, unclassified] }), signal);

      expect(vocabulary.load).toHaveBeenCalledWith(
        'platform',
        'g1',
        [
          { externalId: '6', name: 'PC (Microsoft Windows)', abbreviation: 'PC', platformType: PlatformType.PC },
          { externalId: '99', name: 'Odd', abbreviation: 'PC', platformType: PlatformType.Other },
        ],
        signal,
      );
    });

    it('links categories and mechanics by external id and name', async () => {
      const driver = new InMemoryGatewayDriver({
        categories: [{ externalId: '15', name: 'Strategy' }],
        mechanics: [{ externalId: '2082', name: 'Worker Placement' }],
      });

      await service.load(GW, ListCategories, driver, signal);
      await service.load(GW, ListMechanics, driver, signal);

      expect(vocabulary.load).toHaveBeenCalledWith('category', GW, [{ externalId: '15', name: 'Strategy' }], signal);
      expect(vocabulary.load).toHaveBeenCalledWith(
        'mechanic',
        GW,
        [{ externalId: '2082', name: 'Worker Placement' }],
        signal,
      );
    });
  });

  describe('when it fails', () => {
    it('fails ListUnsupported when the DataGateway answers UNIMPLEMENTED', async () => {
      const driver = new InMemoryGatewayDriver({ capabilities: [proto.Capability.CAPABILITY_FETCH] });

      await expect(failureOf(service.load(GW, ListPlatforms, driver, signal))).resolves.toBe(
        DataGatewaySectionFailure.ListUnsupported,
      );
      expect(vocabulary.load).not.toHaveBeenCalled();
    });

    it('fails ListFailed when the list call fails in another way', async () => {
      const driver = new InMemoryGatewayDriver();
      driver.failWith(new Error('upstream timeout'));

      await expect(failureOf(service.load(GW, ListLanguages, driver, signal))).resolves.toBe(
        DataGatewaySectionFailure.ListFailed,
      );
      expect(languageLinks.interview).not.toHaveBeenCalled();
    });

    it('fails ListFailed, and drops the call, when the DataGateway doesn’t answer in time', async () => {
      // A list job holds the queue's only slot, so a DataGateway that never
      // answers would hold up every other's lists (#722 sets the real deadlines).
      jest.useFakeTimers();
      try {
        let dropped = false;
        const silent = new Observable<never>(() => () => {
          dropped = true;
        });
        const driver = Object.assign(new InMemoryGatewayDriver(), { listCategories: () => silent });
        const failure = failureOf(service.load(GW, ListCategories, driver, signal));

        await jest.advanceTimersByTimeAsync(SECTION_LIST_TIMEOUT_MS - 1);
        expect(dropped).toBe(false);

        await jest.advanceTimersByTimeAsync(1);
        await expect(failure).resolves.toBe(DataGatewaySectionFailure.ListFailed);
        expect(dropped).toBe(true);
        expect(vocabulary.load).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('fails LinkFailed when writing the links throws', async () => {
      vocabulary.load.mockRejectedValue(new Error('deadlock detected'));
      languageLinks.interview.mockRejectedValue(new Error('deadlock detected'));

      await expect(failureOf(service.load(GW, ListMechanics, new InMemoryGatewayDriver(), signal))).resolves.toBe(
        DataGatewaySectionFailure.LinkFailed,
      );
      await expect(failureOf(service.load(GW, ListLanguages, new InMemoryGatewayDriver(), signal))).resolves.toBe(
        DataGatewaySectionFailure.LinkFailed,
      );
    });

    it('rethrows an abort as it is, not as a section failure', async () => {
      const reason = new Error('the connection was replaced');

      const writing = new AbortController();
      vocabulary.load.mockImplementation(async () => {
        writing.abort(reason);
        throw reason;
      });
      await expect(service.load(GW, ListCategories, new InMemoryGatewayDriver(), writing.signal)).rejects.toBe(reason);

      const waiting = new AbortController();
      const driver = Object.assign(new InMemoryGatewayDriver(), { listPlatforms: () => NEVER });
      const loading = service.load(GW, ListPlatforms, driver, waiting.signal);
      waiting.abort(reason);
      await expect(loading).rejects.toBe(reason);
    });
  });

  describe('recording the outcome', () => {
    const at = new Date('2026-10-21T12:00:00.000Z');

    beforeEach(() => {
      db.dataGateway.findFirst.mockResolvedValue({ id: GW } as never);
    });

    it('records a load on the section’s row', async () => {
      await service.recordLoaded(GW, ListPlatforms, at);

      expect(db.dataGateway.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: GW, enabled: true, deletedAt: null } }),
      );
      expect(db.dataGatewaySection.upsert).toHaveBeenCalledWith({
        where: { gatewayId_capability: { gatewayId: GW, capability: ListPlatforms } },
        create: { gatewayId: GW, capability: ListPlatforms, lastLoadedAt: at },
        update: { lastLoadedAt: at },
      });
    });

    it('records a failure, with its code, on the section’s row', async () => {
      await service.recordFailed(GW, ListPlatforms, DataGatewaySectionFailure.ListFailed, at);

      expect(db.dataGatewaySection.upsert).toHaveBeenCalledWith({
        where: { gatewayId_capability: { gatewayId: GW, capability: ListPlatforms } },
        create: {
          gatewayId: GW,
          capability: ListPlatforms,
          lastFailedAt: at,
          lastFailure: DataGatewaySectionFailure.ListFailed,
        },
        update: { lastFailedAt: at, lastFailure: DataGatewaySectionFailure.ListFailed },
      });
    });

    it('records nothing for a DataGateway disabled or deleted meanwhile', async () => {
      db.dataGateway.findFirst.mockResolvedValue(null);

      await service.recordLoaded(GW, ListPlatforms, at);
      await service.recordFailed(GW, ListPlatforms, DataGatewaySectionFailure.LinkFailed, at);

      expect(db.dataGatewaySection.upsert).not.toHaveBeenCalled();
    });
  });
});
