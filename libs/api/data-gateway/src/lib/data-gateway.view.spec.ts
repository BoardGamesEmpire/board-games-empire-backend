import { AuthType, DataGateway, DataGatewayInterviewFailure } from '@bge/database';
import { interviewStatus, toDataGatewayView } from './data-gateway.view';

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

function makeGateway(overrides: Partial<DataGateway> = {}): DataGateway {
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
    ...overrides,
  };
}
