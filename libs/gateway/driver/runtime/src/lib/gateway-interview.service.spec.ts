import { SystemActorScope } from '@bge/actor-context';
import {
  ContentFormat,
  ContentType,
  DatabaseService,
  DataGatewayCapability,
  DataGatewayInterviewFailure,
  LanguageCodeFormat,
  PlatformType,
  ResourceType,
} from '@bge/database';
import { LanguageLinkService } from '@bge/language';
import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import { InMemoryGatewayDriver } from '@boardgamesempire/gateway-driver-contract-testing';
import * as proto from '@boardgamesempire/proto-gateway';
import { status } from '@grpc/grpc-js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { setTimeout as delay } from 'node:timers/promises';
import { concatMap, from, NEVER, of, tap, throwError } from 'rxjs';
import { GatewayInterviewError } from './errors/gateway-interview.error';
import { GatewayCapabilitiesChangedEvent } from './events/gateway-registry.events';
import { GatewayInterviewService } from './gateway-interview.service';
import { FakeDataGatewayTable } from './testing/fake-data-gateway-table';

const GW = 'bgg';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** What the stub DataGateway answers: every operation, tabletop base games and expansions, BCP 47 and plain text. */
const STUB_DESCRIPTION: proto.DescribeResponse = {
  correlationId: 'describe',
  capabilities: [
    proto.Capability.CAPABILITY_SEARCH,
    proto.Capability.CAPABILITY_FETCH,
    proto.Capability.CAPABILITY_FETCH_EXPANSIONS,
    proto.Capability.CAPABILITY_LIST_LANGUAGES,
  ],
  coverage: {
    platformTypes: [proto.PlatformType.PLATFORM_TYPE_TABLETOP],
    contentTypes: [proto.ContentType.CONTENT_TYPE_BASE_GAME, proto.ContentType.CONTENT_TYPE_EXPANSION],
  },
  filterableAxes: [],
  languageCodeFormats: {
    acceptedRequestFormats: [proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47],
    responseFormat: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47,
    passthroughSearchLanguage: false,
  },
  contentFormat: proto.ContentFormat.CONTENT_FORMAT_PLAIN_TEXT,
};

interface Answers {
  /** What Describe answers. Over gRPC an unset field arrives missing, so a partial answer is cast. */
  description?: Partial<proto.DescribeResponse>;
  version?: string;
  languages?: proto.GatewayLanguageEntry[];
}

/** A DataGateway that answers Ping with `version`, Describe with `description`, and ListLanguages with `languages`. */
const dataGateway = ({ description = STUB_DESCRIPTION, version = '1.4.0', languages = [] }: Answers = {}) =>
  Object.assign(new InMemoryGatewayDriver({ gatewayName: 'BoardGameGeekGateway', languages }), {
    ping: () =>
      of<proto.GatewayPingResponse>({
        correlationId: 'ping',
        timestampMs: 0n,
        gatewayName: 'BGG',
        gatewayVersion: version,
      }),
    describe: () => of({ correlationId: 'describe', ...description } as proto.DescribeResponse),
  }) satisfies DataGatewayDriver;

const ENGLISH: proto.GatewayLanguageEntry = {
  value: 'en-US',
  format: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47,
  ietfTag: 'en-US',
  iso6393: 'eng',
  iso6391: 'en',
  name: 'English (US)',
};

/** Lets an interview under way go as far as it can without the DataGateway. */
const settle = () => delay(0);

/** STUB_DESCRIPTION without ListLanguages. */
const WITHOUT_LANGUAGES: proto.DescribeResponse = {
  ...STUB_DESCRIPTION,
  capabilities: STUB_DESCRIPTION.capabilities.filter(
    (capability) => capability !== proto.Capability.CAPABILITY_LIST_LANGUAGES,
  ),
};

describe('GatewayInterviewService', () => {
  let table: FakeDataGatewayTable;
  let languageLinks: { interview: jest.Mock };
  let systemActorScope: { run: jest.Mock };
  let emitted: GatewayCapabilitiesChangedEvent[];
  let service: GatewayInterviewService;

  beforeEach(async () => {
    table = new FakeDataGatewayTable();
    languageLinks = { interview: jest.fn().mockResolvedValue({ resolved: 0, pending: 0, unresolved: 0, ignored: 0 }) };
    systemActorScope = { run: jest.fn((_reason: string, fn: () => unknown) => fn()) };

    const module = await Test.createTestingModule({
      providers: [
        GatewayInterviewService,
        EventEmitter2,
        { provide: DatabaseService, useValue: { dataGateway: table.delegate } },
        { provide: LanguageLinkService, useValue: languageLinks },
        { provide: SystemActorScope, useValue: systemActorScope },
      ],
    }).compile();

    service = module.get(GatewayInterviewService);

    emitted = [];
    module
      .get(EventEmitter2)
      .on(GatewayCapabilitiesChangedEvent.eventName, (event: GatewayCapabilitiesChangedEvent) => {
        emitted.push(event);
      });
  });

  describe('storing the answers', () => {
    it('stores what a DataGateway says about itself, in the server’s terms, and marks its first interview', async () => {
      table.seed({ id: GW });

      await service.interview(GW, dataGateway());

      const row = table.row(GW);
      expect(row).toMatchObject({
        capabilities: [
          DataGatewayCapability.Search,
          DataGatewayCapability.Fetch,
          DataGatewayCapability.FetchExpansions,
          DataGatewayCapability.ListLanguages,
        ],
        coveragePlatformTypes: [PlatformType.Tabletop],
        coverageContentTypes: [ContentType.BaseGame, ContentType.Expansion],
        filterableAxes: [],
        acceptedLanguageCodeFormats: [LanguageCodeFormat.IetfBcp47],
        responseLanguageCodeFormat: LanguageCodeFormat.IetfBcp47,
        passthroughSearchLanguage: false,
        contentFormat: ContentFormat.PlainText,
        gatewayVersion: '1.4.0',
        lastInterviewFailedAt: null,
        lastInterviewFailure: null,
      });
      expect(row?.firstInterviewedAt).toBeInstanceOf(Date);
      expect(row?.lastInterviewedAt).toEqual(row?.firstInterviewedAt);
    });

    it('stores coverage in the server’s platform types: portable as console, arcade as other', async () => {
      table.seed({ id: GW });
      const coverage: proto.Coverage = {
        platformTypes: [
          proto.PlatformType.PLATFORM_TYPE_ARCADE,
          proto.PlatformType.PLATFORM_TYPE_PORTABLE,
          proto.PlatformType.PLATFORM_TYPE_PC,
          proto.PlatformType.PLATFORM_TYPE_CONSOLE,
        ],
        contentTypes: [proto.ContentType.CONTENT_TYPE_DLC],
      };

      await service.interview(GW, dataGateway({ description: { ...STUB_DESCRIPTION, coverage } }));

      expect(table.row(GW)).toMatchObject({
        coveragePlatformTypes: [PlatformType.Console, PlatformType.PC, PlatformType.Other],
        coverageContentTypes: [ContentType.DLC],
      });
    });

    it('stores an answer the DataGateway leaves unset as unset, without guessing', async () => {
      table.seed({ id: GW });

      await service.interview(GW, dataGateway({ description: { capabilities: [], filterableAxes: [] }, version: '' }));

      expect(table.row(GW)).toMatchObject({
        capabilities: [],
        coveragePlatformTypes: [],
        coverageContentTypes: [],
        acceptedLanguageCodeFormats: [],
        responseLanguageCodeFormat: null,
        passthroughSearchLanguage: null,
        contentFormat: null,
        gatewayVersion: null,
      });
      expect(table.row(GW)?.firstInterviewedAt).toBeInstanceOf(Date);
    });

    it('ignores a value with no stored equivalent, such as one its proto predates', async () => {
      table.seed({ id: GW });
      // gRPC hands over an enum value the server's proto doesn't know as a bare number.
      const unknown = 9 as unknown as proto.Capability;

      await service.interview(
        GW,
        dataGateway({
          description: {
            ...STUB_DESCRIPTION,
            capabilities: [proto.Capability.CAPABILITY_FETCH, unknown, proto.Capability.CAPABILITY_UNSPECIFIED],
            contentFormat: 7 as unknown as proto.ContentFormat,
          },
        }),
      );

      expect(table.row(GW)).toMatchObject({ capabilities: [DataGatewayCapability.Fetch], contentFormat: null });
    });

    it('keeps the DataGateway’s order for the request language formats it prefers, and the server’s order for every other list', async () => {
      table.seed({ id: GW });

      await service.interview(
        GW,
        dataGateway({
          description: {
            ...STUB_DESCRIPTION,
            capabilities: [proto.Capability.CAPABILITY_FETCH, proto.Capability.CAPABILITY_SEARCH],
            languageCodeFormats: {
              acceptedRequestFormats: [
                proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_ISO_639_1,
                proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47,
              ],
              responseFormat: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_NAME,
              passthroughSearchLanguage: true,
            },
          },
        }),
      );

      expect(table.row(GW)).toMatchObject({
        capabilities: [DataGatewayCapability.Search, DataGatewayCapability.Fetch],
        acceptedLanguageCodeFormats: [LanguageCodeFormat.Iso6391, LanguageCodeFormat.IetfBcp47],
        responseLanguageCodeFormat: LanguageCodeFormat.Name,
        passthroughSearchLanguage: true,
      });
    });
  });

  describe('the language section', () => {
    it('links each language the DataGateway lists, in the server’s formats', async () => {
      table.seed({ id: GW });

      await service.interview(GW, dataGateway({ languages: [ENGLISH] }));

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
        expect.any(AbortSignal),
      );
    });

    it('leaves out a listed language it can’t read, and links the rest', async () => {
      table.seed({ id: GW });
      const blank: proto.GatewayLanguageEntry = { ...ENGLISH, value: '  ' };
      const unknownFormat: proto.GatewayLanguageEntry = {
        ...ENGLISH,
        value: 'xx',
        format: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_UNSPECIFIED,
      };

      await service.interview(GW, dataGateway({ languages: [blank, unknownFormat, ENGLISH] }));

      expect(languageLinks.interview).toHaveBeenCalledWith(
        GW,
        [expect.objectContaining({ value: 'en-US' })],
        expect.any(AbortSignal),
      );
    });

    it('never asks a DataGateway that doesn’t declare ListLanguages for its languages', async () => {
      table.seed({ id: GW });
      const driver = dataGateway({ description: WITHOUT_LANGUAGES, languages: [ENGLISH] });
      const listLanguages = jest.spyOn(driver, 'listLanguages');

      await service.interview(GW, driver);

      expect(listLanguages).not.toHaveBeenCalled();
      expect(languageLinks.interview).not.toHaveBeenCalled();
    });

    it('skips the section while an admin has ListLanguages switched off', async () => {
      table.seed({ id: GW, disabledCapabilities: [DataGatewayCapability.ListLanguages] });
      const driver = dataGateway({ languages: [ENGLISH] });
      const listLanguages = jest.spyOn(driver, 'listLanguages');

      await service.interview(GW, driver);

      expect(listLanguages).not.toHaveBeenCalled();
      expect(table.row(GW)?.capabilities).toContain(DataGatewayCapability.ListLanguages);
    });

    it('still succeeds when the section fails, and records the failure beside the success', async () => {
      table.seed({ id: GW });
      const driver = dataGateway();
      driver.listLanguages = () => throwError(() => new Error('upstream timeout'));

      await service.interview(GW, driver);

      const row = table.row(GW);
      expect(row).toMatchObject({
        capabilities: expect.arrayContaining([DataGatewayCapability.Search]),
        lastInterviewFailure: DataGatewayInterviewFailure.LanguageSectionFailed,
      });
      expect(row?.firstInterviewedAt).toBeInstanceOf(Date);
      expect(row?.lastInterviewFailedAt).toEqual(row?.lastInterviewedAt);
    });
  });

  describe('when it fails', () => {
    /** A row answered by an earlier interview, the day before. */
    const interviewedYesterday = () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      return table.seed({
        id: GW,
        capabilities: [DataGatewayCapability.Search],
        contentFormat: ContentFormat.Html,
        gatewayVersion: '1.3.0',
        firstInterviewedAt: yesterday,
        lastInterviewedAt: yesterday,
      });
    };

    it('fails, and records that the DataGateway doesn’t implement Describe', async () => {
      table.seed({ id: GW });
      const driver = dataGateway();
      driver.describe = () =>
        throwError(() => Object.assign(new Error('12 UNIMPLEMENTED'), { code: status.UNIMPLEMENTED }));

      await expect(service.interview(GW, driver)).rejects.toMatchObject({
        failure: DataGatewayInterviewFailure.DescribeUnsupported,
      });

      expect(table.row(GW)).toMatchObject({
        lastInterviewFailure: DataGatewayInterviewFailure.DescribeUnsupported,
        lastInterviewFailedAt: expect.any(Date),
        firstInterviewedAt: null,
        capabilities: [],
      });
    });

    it('fails, and records a Describe that failed in some other way', async () => {
      table.seed({ id: GW });
      const driver = dataGateway();
      driver.describe = () => throwError(() => new Error('14 UNAVAILABLE'));

      await expect(service.interview(GW, driver)).rejects.toMatchObject({
        failure: DataGatewayInterviewFailure.DescribeFailed,
      });
      expect(table.row(GW)?.lastInterviewFailure).toBe(DataGatewayInterviewFailure.DescribeFailed);
    });

    it('fails, and records a ping that went unanswered, without going on to Describe', async () => {
      table.seed({ id: GW });
      const driver = dataGateway();
      driver.ping = () => throwError(() => new Error('14 UNAVAILABLE'));
      const describe = jest.spyOn(driver, 'describe');

      await expect(service.interview(GW, driver)).rejects.toMatchObject({
        failure: DataGatewayInterviewFailure.PingFailed,
      });
      expect(table.row(GW)?.lastInterviewFailure).toBe(DataGatewayInterviewFailure.PingFailed);
      expect(describe).not.toHaveBeenCalled();
    });

    it('keeps the last good answers in use when a later interview fails', async () => {
      const before = interviewedYesterday();
      const driver = dataGateway();
      driver.describe = () => throwError(() => new Error('boom'));

      await expect(service.interview(GW, driver)).rejects.toThrow();

      expect(table.row(GW)).toMatchObject({
        capabilities: [DataGatewayCapability.Search],
        contentFormat: ContentFormat.Html,
        gatewayVersion: '1.3.0',
        firstInterviewedAt: before.firstInterviewedAt,
        lastInterviewedAt: before.lastInterviewedAt,
        lastInterviewFailure: DataGatewayInterviewFailure.DescribeFailed,
      });
    });

    it('keeps the raw error out of the row', async () => {
      table.seed({ id: GW });
      const driver = dataGateway();
      driver.describe = () => throwError(() => new Error('connect ECONNREFUSED 10.0.0.7:50051'));

      await expect(service.interview(GW, driver)).rejects.toThrow();

      expect(JSON.stringify(table.row(GW))).not.toContain('ECONNREFUSED');
    });
  });

  describe('capability changes', () => {
    /** STUB_DESCRIPTION, declaring only `capabilities`. */
    const declaring = (...capabilities: proto.Capability[]) =>
      dataGateway({ description: { ...STUB_DESCRIPTION, capabilities } });

    it('emits one audited event, as the system, when the capabilities change', async () => {
      table.seed({
        id: GW,
        capabilities: [DataGatewayCapability.Search, DataGatewayCapability.Fetch],
        firstInterviewedAt: new Date(0),
      });

      await service.interview(GW, declaring(proto.Capability.CAPABILITY_SEARCH));

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toBeInstanceOf(GatewayCapabilitiesChangedEvent);
      expect(emitted[0]).toMatchObject({
        action: 'update',
        subject: ResourceType.DataGateway,
        subjectId: GW,
        before: { id: GW, capabilities: [DataGatewayCapability.Search, DataGatewayCapability.Fetch] },
        after: { id: GW, capabilities: [DataGatewayCapability.Search] },
      });
      expect(systemActorScope.run).toHaveBeenCalledWith('gateway-registry:interview', expect.any(Function));
      expect(table.row(GW)?.capabilities).toEqual([DataGatewayCapability.Search]);
    });

    it('records the first interview’s capabilities as a change from none', async () => {
      table.seed({ id: GW });

      await service.interview(GW, declaring(proto.Capability.CAPABILITY_FETCH));

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        before: { capabilities: [] },
        after: { capabilities: [DataGatewayCapability.Fetch] },
      });
    });

    it('emits nothing when the capabilities are the same, in whatever order they’re declared', async () => {
      table.seed({ id: GW, capabilities: [DataGatewayCapability.Search, DataGatewayCapability.Fetch] });

      await service.interview(GW, declaring(proto.Capability.CAPABILITY_FETCH, proto.Capability.CAPABILITY_SEARCH));

      expect(emitted).toEqual([]);
    });

    it('emits nothing when another process stored the same change first, and still stores the answers', async () => {
      table.seed({ id: GW, capabilities: [DataGatewayCapability.Search, DataGatewayCapability.Fetch] });
      // The other process's interview lands while this one is in its language section.
      languageLinks.interview.mockImplementation(async () => {
        table.patch(GW, { capabilities: [DataGatewayCapability.Search, DataGatewayCapability.ListLanguages] });
      });

      await service.interview(
        GW,
        declaring(proto.Capability.CAPABILITY_SEARCH, proto.Capability.CAPABILITY_LIST_LANGUAGES),
      );

      expect(emitted).toEqual([]);
      expect(table.row(GW)).toMatchObject({
        capabilities: [DataGatewayCapability.Search, DataGatewayCapability.ListLanguages],
        lastInterviewedAt: expect.any(Date),
      });
    });

    it('records its change against the list another process stored first, when their answers differ', async () => {
      table.seed({
        id: GW,
        capabilities: [DataGatewayCapability.Search, DataGatewayCapability.Fetch, DataGatewayCapability.ListLanguages],
      });
      // The other process's interview, which got a different answer, lands while this one is in its language section.
      languageLinks.interview.mockImplementation(async () => {
        table.patch(GW, { capabilities: [DataGatewayCapability.ListLanguages] });
      });

      await service.interview(
        GW,
        declaring(proto.Capability.CAPABILITY_SEARCH, proto.Capability.CAPABILITY_LIST_LANGUAGES),
      );

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        before: { capabilities: [DataGatewayCapability.ListLanguages] },
        after: { capabilities: [DataGatewayCapability.Search, DataGatewayCapability.ListLanguages] },
      });
      expect(table.row(GW)?.capabilities).toEqual([DataGatewayCapability.Search, DataGatewayCapability.ListLanguages]);
    });

    it('records the change it makes over a list another process stored meanwhile, though its answers match what it read', async () => {
      table.seed({ id: GW, capabilities: [DataGatewayCapability.Search, DataGatewayCapability.Fetch] });
      const driver = declaring(proto.Capability.CAPABILITY_SEARCH, proto.Capability.CAPABILITY_FETCH);
      const describe = driver.describe.bind(driver);
      driver.describe = () => {
        // The other process's interview, which reached a newer build, lands while this one waits on Describe.
        table.patch(GW, { capabilities: [DataGatewayCapability.Search] });
        return describe();
      };

      await service.interview(GW, driver);

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        before: { capabilities: [DataGatewayCapability.Search] },
        after: { capabilities: [DataGatewayCapability.Search, DataGatewayCapability.Fetch] },
      });
      expect(table.row(GW)?.capabilities).toEqual([DataGatewayCapability.Search, DataGatewayCapability.Fetch]);
    });

    it('fails, storing nothing and recording no change, when another process stores first at every try', async () => {
      table.seed({ id: GW, capabilities: [DataGatewayCapability.Search], firstInterviewedAt: new Date(0) });
      const updateMany = table.delegate.updateMany;
      let turn = 0;
      jest.spyOn(table.delegate, 'updateMany').mockImplementation(async (args) => {
        // Another process's interview, with another answer each time, lands just before each write.
        table.patch(GW, {
          capabilities: turn++ % 2 ? [DataGatewayCapability.Search] : [DataGatewayCapability.Fetch],
        });
        return updateMany(args);
      });

      await expect(
        service.interview(GW, declaring(proto.Capability.CAPABILITY_SEARCH, proto.Capability.CAPABILITY_FETCH)),
      ).rejects.toThrow(/kept changing/);

      expect(emitted).toEqual([]);
      expect(table.row(GW)?.lastInterviewedAt).toBeNull();
    });

    it.each([
      ['disables', { enabled: false }],
      ['deletes', { deletedAt: new Date() }],
    ])(
      'fails, storing nothing and recording no change, when an admin %s the DataGateway during it',
      async (_, change) => {
        table.seed({ id: GW, capabilities: [DataGatewayCapability.Search], firstInterviewedAt: new Date(0) });
        const driver = declaring(proto.Capability.CAPABILITY_SEARCH, proto.Capability.CAPABILITY_FETCH);
        const describe = driver.describe.bind(driver);
        driver.describe = () => {
          // The admin's change lands while the interview waits on Describe.
          table.patch(GW, change);
          return describe();
        };

        await expect(service.interview(GW, driver)).rejects.toThrow(/disabled or deleted during its interview/);

        expect(emitted).toEqual([]);
        expect(table.row(GW)).toMatchObject({ capabilities: [DataGatewayCapability.Search], lastInterviewedAt: null });
      },
    );

    it('never touches the capabilities an admin switched off, even one the DataGateway no longer declares', async () => {
      table.seed({
        id: GW,
        capabilities: [DataGatewayCapability.Search, DataGatewayCapability.FetchExpansions],
        disabledCapabilities: [DataGatewayCapability.Search, DataGatewayCapability.FetchExpansions],
      });

      await service.interview(GW, declaring(proto.Capability.CAPABILITY_SEARCH));

      expect(table.row(GW)?.disabledCapabilities).toEqual([
        DataGatewayCapability.Search,
        DataGatewayCapability.FetchExpansions,
      ]);
    });
  });

  describe('a DataGateway an admin disabled or deleted', () => {
    it('isn’t interviewed, even on request', async () => {
      table.seed({ id: GW, enabled: false });
      const driver = dataGateway();
      const describe = jest.spyOn(driver, 'describe');

      await expect(service.interview(GW, driver)).rejects.toThrow(/disabled/);
      expect(describe).not.toHaveBeenCalled();
    });

    it.each([
      ['disables', { enabled: false }],
      ['deletes', { deletedAt: new Date() }],
    ])('keeps its row as it was when an admin %s it during an interview that then fails', async (_, change) => {
      table.seed({ id: GW });
      const driver = dataGateway();
      driver.describe = () => {
        // The admin's change lands while the interview waits on Describe.
        table.patch(GW, change);
        return throwError(() => new Error('14 UNAVAILABLE'));
      };

      await expect(service.interview(GW, driver)).rejects.toMatchObject({
        failure: DataGatewayInterviewFailure.DescribeFailed,
      });
      expect(table.row(GW)).toMatchObject({ lastInterviewFailure: null, lastInterviewFailedAt: null });
    });

    it('isn’t pinged or interviewed by the backstop, though its process may still hold the driver', async () => {
      const stale = new Date(Date.now() - 2 * DAY);
      table.seed({ id: 'disabled', enabled: false, firstInterviewedAt: stale, lastInterviewedAt: stale });
      table.seed({ id: 'deleted', deletedAt: new Date(), firstInterviewedAt: stale, lastInterviewedAt: stale });
      const driver = dataGateway({ version: '9.9.9' });
      const ping = jest.spyOn(driver, 'ping');

      await service.refreshIfStale('disabled', driver);
      await service.refreshIfStale('deleted', driver);

      expect(ping).not.toHaveBeenCalled();
      expect(table.row('disabled')?.lastInterviewedAt).toEqual(stale);
      expect(table.row('deleted')?.lastInterviewedAt).toEqual(stale);
    });
  });

  describe('the first interview', () => {
    it('runs for a DataGateway never interviewed', async () => {
      table.seed({ id: GW });

      await expect(service.interviewUnlessDone(GW, dataGateway())).resolves.toBe(true);

      expect(table.row(GW)?.firstInterviewedAt).toBeInstanceOf(Date);
    });

    it('is skipped when the row shows it already, as when the coordinator got there first', async () => {
      table.seed({ id: GW, firstInterviewedAt: new Date(0), lastInterviewedAt: new Date(0) });
      const driver = dataGateway();
      const describe = jest.spyOn(driver, 'describe');

      await expect(service.interviewUnlessDone(GW, driver)).resolves.toBe(false);

      expect(describe).not.toHaveBeenCalled();
    });

    it('throws when it fails, so the DataGateway isn’t used', async () => {
      table.seed({ id: GW });
      const driver = dataGateway();
      driver.describe = () => throwError(() => new Error('boom'));

      await expect(service.interviewUnlessDone(GW, driver)).rejects.toBeInstanceOf(GatewayInterviewError);
    });

    it.each([
      ['disposes its driver', (driver: DataGatewayDriver) => service.abandon(GW, driver)],
      ['invalidates the DataGateway', () => service.abandon(GW)],
    ])('doesn’t start when the gateway registry %s while the row is read', async (_, letGo) => {
      table.seed({ id: GW });
      const driver = dataGateway();
      const describe = jest.spyOn(driver, 'describe');
      const findUnique = table.delegate.findUnique;
      jest.spyOn(table.delegate, 'findUnique').mockImplementationOnce(async (args) => {
        letGo(driver);
        return findUnique(args);
      });

      await expect(service.interviewUnlessDone(GW, driver)).rejects.toThrow(/abandoned/);

      expect(describe).not.toHaveBeenCalled();
      expect(table.row(GW)?.firstInterviewedAt).toBeNull();
    });

    it('still starts when the gateway registry lets go of another driver while the row is read', async () => {
      table.seed({ id: GW });
      const findUnique = table.delegate.findUnique;
      jest.spyOn(table.delegate, 'findUnique').mockImplementationOnce(async (args) => {
        service.abandon(GW, dataGateway());
        return findUnique(args);
      });

      await expect(service.interviewUnlessDone(GW, dataGateway())).resolves.toBe(true);

      expect(table.row(GW)?.firstInterviewedAt).toBeInstanceOf(Date);
    });

    it('keeps its time when later interviews come', async () => {
      const first = new Date(Date.now() - 3 * DAY);
      table.seed({ id: GW, firstInterviewedAt: first, lastInterviewedAt: first });

      await service.interview(GW, dataGateway());

      const row = table.row(GW);
      expect(row?.firstInterviewedAt).toEqual(first);
      expect(row?.lastInterviewedAt?.getTime()).toBeGreaterThan(first.getTime());
    });

    it('keeps the time of a first interview another process stored meanwhile', async () => {
      table.seed({ id: GW });
      const first = new Date(Date.now() - MINUTE);
      // It declares nothing yet, so both interviews store the capabilities the row already holds.
      const driver = dataGateway({ description: { capabilities: [], filterableAxes: [] } });
      const describe = driver.describe.bind(driver);
      driver.describe = () => {
        // The other process's first interview lands while this one waits on Describe.
        table.patch(GW, { firstInterviewedAt: first, lastInterviewedAt: first });
        return describe();
      };

      await service.interview(GW, driver);

      const row = table.row(GW);
      expect(row?.firstInterviewedAt).toEqual(first);
      expect(row?.lastInterviewedAt?.getTime()).toBeGreaterThan(first.getTime());
    });
  });

  describe('refreshIfStale', () => {
    /** A row interviewed `ago` milliseconds ago, when the DataGateway reported `version`. */
    const interviewed = (ago: number, version: string | null = '1.4.0') => {
      const at = new Date(Date.now() - ago);
      return table.seed({ id: GW, gatewayVersion: version, firstInterviewedAt: at, lastInterviewedAt: at });
    };

    it('re-interviews a DataGateway that reports a different version', async () => {
      interviewed(HOUR, '1.3.0');

      await service.refreshIfStale(GW, dataGateway({ version: '1.4.0' }));

      expect(table.row(GW)?.gatewayVersion).toBe('1.4.0');
      expect(table.row(GW)?.lastInterviewedAt?.getTime()).toBeGreaterThan(Date.now() - MINUTE);
    });

    it('re-interviews once the last interview is a day old, at the same version', async () => {
      interviewed(DAY + MINUTE);

      await service.refreshIfStale(GW, dataGateway());

      expect(table.row(GW)?.lastInterviewedAt?.getTime()).toBeGreaterThan(Date.now() - MINUTE);
    });

    it('leaves a DataGateway interviewed within the day at the same version alone', async () => {
      const row = interviewed(HOUR);
      const driver = dataGateway();
      const describe = jest.spyOn(driver, 'describe');

      await service.refreshIfStale(GW, driver);

      expect(describe).not.toHaveBeenCalled();
      expect(table.row(GW)?.lastInterviewedAt).toEqual(row.lastInterviewedAt);
    });

    it('never re-interviews for a version change when the DataGateway reports no version', async () => {
      interviewed(HOUR, '1.3.0');
      const driver = dataGateway({ version: '' });
      const describe = jest.spyOn(driver, 'describe');

      await service.refreshIfStale(GW, driver);

      expect(describe).not.toHaveBeenCalled();
    });

    it('only logs a ping that fails: the row records nothing and keeps its answers', async () => {
      const row = interviewed(DAY + MINUTE);
      const driver = dataGateway();
      driver.ping = () => throwError(() => new Error('14 UNAVAILABLE'));

      await expect(service.refreshIfStale(GW, driver)).resolves.toBeUndefined();

      expect(table.row(GW)).toEqual(row);
    });

    it('starts no second check through a driver whose last one still waits, as on a DataGateway that never answers', async () => {
      interviewed(DAY + MINUTE);
      const driver = Object.assign(dataGateway(), { ping: jest.fn(() => NEVER) });

      void service.refreshIfStale(GW, driver);
      await expect(service.refreshIfStale(GW, driver)).resolves.toBeUndefined();

      expect(driver.ping).toHaveBeenCalledTimes(1);
    });

    it('still checks through a new driver while a check through the old one waits', async () => {
      interviewed(DAY + MINUTE);
      void service.refreshIfStale(GW, Object.assign(dataGateway(), { ping: () => NEVER }));

      await service.refreshIfStale(GW, dataGateway({ version: '2.0.0' }));

      expect(table.row(GW)?.gatewayVersion).toBe('2.0.0');
    });

    it.each([
      ['disposes its driver', (driver: DataGatewayDriver) => service.abandon(GW, driver)],
      ['invalidates the DataGateway', () => service.abandon(GW)],
    ])('stops waiting on a ping that never answers when the gateway registry %s', async (_, letGo) => {
      const row = interviewed(DAY + MINUTE);
      const driver = Object.assign(dataGateway(), { ping: () => NEVER });
      let stopped = false;
      void service.refreshIfStale(GW, driver).then(() => (stopped = true));
      await settle();

      letGo(driver);
      await settle();

      expect(stopped).toBe(true);
      expect(table.row(GW)).toEqual(row);
    });

    it('starts no interview when the gateway registry lets go of the driver as the ping answers', async () => {
      const row = interviewed(HOUR, '1.3.0');
      const driver = dataGateway({ version: '2.0.0' });
      const ping = driver.ping.bind(driver);
      // The driver is let go of once the answer is on its way, before the check reads it.
      driver.ping = () => ping().pipe(tap(() => queueMicrotask(() => service.abandon(GW, driver))));
      const describe = jest.spyOn(driver, 'describe');

      await service.refreshIfStale(GW, driver);

      expect(describe).not.toHaveBeenCalled();
      expect(table.row(GW)).toEqual(row);
    });

    it('leaves alone a check asking through another driver', async () => {
      interviewed(HOUR, '1.3.0');
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => (answer = resolve));
      const driver = dataGateway({ version: '2.0.0' });
      const ping = driver.ping.bind(driver);
      driver.ping = () => from(answered).pipe(concatMap(() => ping()));
      const checking = service.refreshIfStale(GW, driver);
      await settle();

      service.abandon(GW, dataGateway());
      answer();

      await checking;
      expect(table.row(GW)?.gatewayVersion).toBe('2.0.0');
    });

    it('never throws when the re-interview fails, and records the failure', async () => {
      interviewed(DAY + MINUTE);
      const driver = dataGateway();
      driver.describe = () => throwError(() => new Error('boom'));

      await expect(service.refreshIfStale(GW, driver)).resolves.toBeUndefined();

      expect(table.row(GW)?.lastInterviewFailure).toBe(DataGatewayInterviewFailure.DescribeFailed);
    });
  });

  describe('when the gateway registry lets go of its driver', () => {
    it('stops waiting on the DataGateway, writes nothing, and lets the next interview start afresh', async () => {
      table.seed({ id: GW });
      const stuck = service.interview(GW, Object.assign(dataGateway(), { describe: () => NEVER }));
      await settle();

      service.abandon(GW);

      await expect(stuck).rejects.toThrow(/abandoned/);
      await service.interview(GW, dataGateway({ version: '2.0.0' }));
      expect(table.row(GW)).toMatchObject({ gatewayVersion: '2.0.0', lastInterviewFailure: null });
    });

    it('stores nothing once abandoned, even with the answers in', async () => {
      table.seed({ id: GW });
      languageLinks.interview.mockImplementation(async () => service.abandon(GW));

      await expect(service.interview(GW, dataGateway({ languages: [ENGLISH] }))).rejects.toThrow(/abandoned/);

      expect(table.row(GW)).toMatchObject({ capabilities: [], firstInterviewedAt: null, lastInterviewFailure: null });
    });

    it('stops its language section from linking further languages', async () => {
      table.seed({ id: GW });
      let section: AbortSignal | undefined;
      languageLinks.interview.mockImplementation(async (_gatewayId: string, _entries: unknown, signal: AbortSignal) => {
        section = signal;
        service.abandon(GW);
      });

      await expect(service.interview(GW, dataGateway({ languages: [ENGLISH] }))).rejects.toThrow(/abandoned/);

      expect(section?.aborted).toBe(true);
    });

    it('stops retrying a write that missed', async () => {
      table.seed({ id: GW, capabilities: [DataGatewayCapability.Search] });
      const updateMany = table.delegate.updateMany;
      jest.spyOn(table.delegate, 'updateMany').mockImplementationOnce(async (args) => {
        // Another process's interview lands first, and then the gateway registry lets go of the driver.
        table.patch(GW, { capabilities: [DataGatewayCapability.Fetch] });
        service.abandon(GW);
        return updateMany(args);
      });

      await expect(service.interview(GW, dataGateway())).rejects.toThrow(/abandoned/);

      expect(table.delegate.updateMany).toHaveBeenCalledTimes(1);
      expect(table.row(GW)).toMatchObject({ capabilities: [DataGatewayCapability.Fetch], firstInterviewedAt: null });
    });

    it('leaves alone an interview asking through another driver', async () => {
      table.seed({ id: GW });
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => (answer = resolve));
      const driver = dataGateway();
      const describe = driver.describe.bind(driver);
      driver.describe = () => from(answered).pipe(concatMap(() => describe()));
      const interviewing = service.interview(GW, driver);
      await settle();

      service.abandon(GW, dataGateway());
      answer();

      await expect(interviewing).resolves.toBeUndefined();
      expect(table.row(GW)?.firstInterviewedAt).toBeInstanceOf(Date);
    });
  });

  it('asks a DataGateway once when several callers want it interviewed at the same time', async () => {
    table.seed({ id: GW });
    const driver = dataGateway();
    const describe = jest.spyOn(driver, 'describe');

    await Promise.all([service.interview(GW, driver), service.interview(GW, driver)]);

    expect(describe).toHaveBeenCalledTimes(1);
  });
});
