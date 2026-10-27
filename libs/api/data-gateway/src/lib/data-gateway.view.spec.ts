import {
  AuthType,
  DataGatewayCapability,
  DataGatewayInterviewFailure,
  DataGatewaySectionFailure,
  type DataGatewaySection,
} from '@bge/database';
import { interviewStatus, sectionStatus, toDataGatewayView, type DataGatewayWithSections } from './data-gateway.view';

const T1 = new Date('2026-10-01T12:00:00.000Z');
const T2 = new Date('2026-10-02T12:00:00.000Z');

describe('interviewStatus', () => {
  it('reports a DataGateway never interviewed, with no failure', () => {
    expect(interviewStatus(columns())).toEqual({
      interviewed: false,
      firstInterviewedAt: null,
      lastInterviewedAt: null,
      failure: null,
    });
  });

  it('reports the failure of a first interview that never succeeded', () => {
    const status = interviewStatus(
      columns({ lastInterviewFailedAt: T1, lastInterviewFailure: DataGatewayInterviewFailure.PingFailed }),
    );

    expect(status).toEqual({
      interviewed: false,
      firstInterviewedAt: null,
      lastInterviewedAt: null,
      failure: { code: DataGatewayInterviewFailure.PingFailed, at: T1 },
    });
  });

  // A later success leaves the failure columns in place (#712), so the status
  // has to compare the two times rather than read the failure columns alone.
  it('drops a failure once a later interview succeeded', () => {
    const status = interviewStatus(
      columns({
        firstInterviewedAt: T2,
        lastInterviewedAt: T2,
        lastInterviewFailedAt: T1,
        lastInterviewFailure: DataGatewayInterviewFailure.DescribeFailed,
      }),
    );

    expect(status.interviewed).toBe(true);
    expect(status.failure).toBeNull();
  });

  it('reports a failure newer than the last success', () => {
    const status = interviewStatus(
      columns({
        firstInterviewedAt: T1,
        lastInterviewedAt: T1,
        lastInterviewFailedAt: T2,
        lastInterviewFailure: DataGatewayInterviewFailure.DescribeFailed,
      }),
    );

    expect(status.interviewed).toBe(true);
    expect(status.failure).toEqual({ code: DataGatewayInterviewFailure.DescribeFailed, at: T2 });
  });

  it.each([
    ['a failure time with no code', { lastInterviewFailedAt: T1 }],
    ['a code with no failure time', { lastInterviewFailure: DataGatewayInterviewFailure.PingFailed }],
  ] as const)('reports no failure for %s', (_case, half) => {
    expect(interviewStatus(columns(half)).failure).toBeNull();
  });
});

describe('toDataGatewayView', () => {
  // #753: the stored credentials never leave the server, not even as a key
  // set to undefined that a serializer might still emit.
  it('removes the authParameters key', () => {
    const view = toDataGatewayView(makeGateway({ authParameters: { apiKey: 'secret' } }));

    expect(view).not.toHaveProperty('authParameters');
  });

  it.each([
    ['null', null, false],
    ['an empty object', {}, false],
    ['a stored key', { apiKey: 'x' }, true],
  ] as const)('says whether credentials are stored, given %s', (_case, authParameters, expected) => {
    expect(toDataGatewayView(makeGateway({ authParameters })).hasAuthParameters).toBe(expected);
  });

  it('carries the interview status beside the raw columns', () => {
    const row = makeGateway({
      firstInterviewedAt: T1,
      lastInterviewedAt: T1,
      lastInterviewFailedAt: T1,
      lastInterviewFailure: DataGatewayInterviewFailure.DescribeFailed,
    });

    const view = toDataGatewayView(row);

    expect(view.interview).toEqual(interviewStatus(row));
    expect(view.lastInterviewFailure).toBe(DataGatewayInterviewFailure.DescribeFailed);
    expect(view.id).toBe(row.id);
  });
});

describe('sectionStatus', () => {
  const at = (time: string) => new Date(`2026-10-21T${time}:00.000Z`);

  it('reports each section’s last load, and its failure only while current (#718)', () => {
    const loadedSinceFailing = sectionStatus(
      section({
        lastLoadedAt: at('10:00'),
        lastFailedAt: at('09:00'),
        lastFailure: DataGatewaySectionFailure.ListFailed,
      }),
    );
    const failedSinceLoading = sectionStatus(
      section({
        lastLoadedAt: at('10:00'),
        lastFailedAt: at('11:00'),
        lastFailure: DataGatewaySectionFailure.LinkFailed,
      }),
    );
    const neverLoaded = sectionStatus(
      section({ lastFailedAt: at('11:00'), lastFailure: DataGatewaySectionFailure.ListUnsupported }),
    );

    expect(loadedSinceFailing).toEqual({
      capability: DataGatewayCapability.ListPlatforms,
      lastLoadedAt: at('10:00'),
      failure: null,
    });
    expect(failedSinceLoading.failure).toEqual({ code: DataGatewaySectionFailure.LinkFailed, at: at('11:00') });
    expect(neverLoaded).toEqual({
      capability: DataGatewayCapability.ListPlatforms,
      lastLoadedAt: null,
      failure: { code: DataGatewaySectionFailure.ListUnsupported, at: at('11:00') },
    });
  });

  it('reports no failure for a half-written pair', () => {
    expect(sectionStatus(section({ lastFailedAt: at('11:00') })).failure).toBeNull();
  });
});

describe('toDataGatewayView sections', () => {
  it('returns sections in capability order, without the raw rows', () => {
    const view = toDataGatewayView(
      makeGateway({
        capabilities: [
          DataGatewayCapability.ListLanguages,
          DataGatewayCapability.ListPlatforms,
          DataGatewayCapability.ListMechanics,
        ],
        sections: [
          section({ capability: DataGatewayCapability.ListMechanics, lastLoadedAt: T1 }),
          section({ capability: DataGatewayCapability.ListLanguages, lastLoadedAt: T2 }),
          section({ capability: DataGatewayCapability.ListPlatforms, lastLoadedAt: T1 }),
        ],
      }),
    );

    expect(view.sections).toEqual([
      { capability: DataGatewayCapability.ListLanguages, lastLoadedAt: T2, failure: null },
      { capability: DataGatewayCapability.ListPlatforms, lastLoadedAt: T1, failure: null },
      { capability: DataGatewayCapability.ListMechanics, lastLoadedAt: T1, failure: null },
    ]);
  });

  // No job runs for those lists again, so a failure recorded before would
  // read as current for good (#718).
  it('leaves out the sections of lists no longer declared or switched off', () => {
    const failed = { lastFailedAt: T2, lastFailure: DataGatewaySectionFailure.ListFailed };
    const view = toDataGatewayView(
      makeGateway({
        capabilities: [DataGatewayCapability.ListPlatforms, DataGatewayCapability.ListCategories],
        disabledCapabilities: [DataGatewayCapability.ListCategories],
        sections: [
          section({ capability: DataGatewayCapability.ListPlatforms, lastLoadedAt: T1 }),
          section({ capability: DataGatewayCapability.ListCategories, ...failed }),
          section({ capability: DataGatewayCapability.ListMechanics, ...failed }),
        ],
      }),
    );

    expect(view.sections).toEqual([
      { capability: DataGatewayCapability.ListPlatforms, lastLoadedAt: T1, failure: null },
    ]);
  });
});

function section(overrides: Partial<DataGatewaySection> = {}): DataGatewaySection {
  return {
    gatewayId: 'gw-1',
    capability: DataGatewayCapability.ListPlatforms,
    lastLoadedAt: null,
    lastFailedAt: null,
    lastFailure: null,
    ...overrides,
  };
}

type InterviewColumns = Parameters<typeof interviewStatus>[0];

function columns(overrides: Partial<InterviewColumns> = {}): InterviewColumns {
  return {
    firstInterviewedAt: null,
    lastInterviewedAt: null,
    lastInterviewFailedAt: null,
    lastInterviewFailure: null,
    ...overrides,
  };
}

function makeGateway(overrides: Partial<DataGatewayWithSections> = {}): DataGatewayWithSections {
  return {
    id: 'gw-1',
    name: 'Test Gateway',
    description: null,
    messageContext: null,
    iconUrl: null,
    logoUrl: null,
    websiteUrl: null,
    apiBaseUrl: null,
    apiDocumentation: null,
    apiVersion: null,
    connectionUrl: 'localhost',
    connectionPort: 50051,
    enabled: true,
    authType: AuthType.None,
    authParameters: null,
    usageCount: 0,
    lastUsed: null,
    capabilities: [],
    coveragePlatformTypes: [],
    coverageContentTypes: [],
    filterableAxes: [],
    acceptedLanguageCodeFormats: [],
    responseLanguageCodeFormat: null,
    passthroughSearchLanguage: null,
    contentFormat: null,
    gatewayVersion: null,
    disabledCapabilities: [],
    firstInterviewedAt: null,
    lastInterviewedAt: null,
    lastInterviewFailedAt: null,
    lastInterviewFailure: null,
    createdById: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    sections: [],
    ...overrides,
  };
}
