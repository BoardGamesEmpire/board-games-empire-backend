import { DatabaseService } from '@bge/database';
import * as jest from 'jest-mock';

/**
 * Wraps each function-valued property of T as a jest.MockedFunction,
 * preserving non-function properties as-is.
 */
type MockedFunctions<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? jest.MockedFunction<(...args: A) => R> : T[K];
};

/**
 * Top-level mapped type for DatabaseService:
 *  - Functions ($connect, $disconnect, etc.) → jest.MockedFunction
 *  - Objects (model delegates like game, user, etc.) → each method mocked
 */
type MockedMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? jest.MockedFunction<(...args: A) => R>
    : MockedFunctions<T[K]>;
};

/**
 * Delegates are exposed as `MockedMethods` so tests get full autocomplete
 * on both the Prisma delegate shape and the jest mock API:
 *   db.user.findMany.mockResolvedValue([makeUser()])
 *   db.user.create.mockRejectedValue(new Error('conflict'))
 *
 * $transaction is re-typed so tests can pass a callback that receives
 * MockDatabaseService directly, avoiding the structural mismatch with the
 * full PrismaClient type:
 *   db.$transaction.mockImplementation((cb) => cb(db))
 */
type _MockDatabaseBase = MockedMethods<Pick<DatabaseService, keyof DatabaseService>>;
export type MockDatabaseService = Omit<_MockDatabaseBase, '$transaction'> & {
  $transaction: jest.MockedFunction<(fn: (tx: MockDatabaseService) => Promise<unknown>) => Promise<unknown>>;
};

/**
 * A jest.fn() delegate factory for a single Prisma model.
 * Cast via `as unknown` to avoid the `Mock<UnknownFunction>` mismatch —
 * MockDatabaseService's mapped type provides the correct shape at call sites.
 */
function mockDelegate() {
  return {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findFirstOrThrow: jest.fn(),
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    create: jest.fn(),
    createMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
    groupBy: jest.fn(),
  };
}

/**
 * Creates a fully-typed mock of DatabaseService.
 *
 * Usage:
 *   const db = createMockDatabaseService();
 *   // in TestingModule providers:
 *   { provide: DatabaseService, useValue: db }
 */
export function createMockDatabaseService(): MockDatabaseService {
  return {
    // --- Prisma $ utilities ---
    // @ts-expect-error -- mocked as jest.MockedFunction
    $connect: jest.fn().mockResolvedValue(undefined),
    // @ts-expect-error -- mocked as jest.MockedFunction
    $disconnect: jest.fn().mockResolvedValue(undefined),
    // The ARRAY form resolves like Prisma's does — every operation settles and
    // the results come back positionally — because a paginated read issues its
    // rows and its `count` as one transaction (#230), and an unstubbed mock
    // returning `undefined` would fail at the destructure rather than at an
    // assertion. The callback form is left inert for a spec to stub, which is
    // the behaviour every existing caller was written against.
    $transaction: jest.fn((operations: unknown) =>
      Array.isArray(operations) ? Promise.all(operations) : undefined,
    ) as unknown as MockDatabaseService['$transaction'],
    // Raw helpers resolve to their real empty shapes rather than `undefined`.
    // A bare jest.fn() models a client that returns nothing, which no Prisma raw
    // query ever does: `$queryRaw` yields a row array and `$executeRaw` an
    // affected-row count. The difference is invisible until production code
    // touches the result — an unstubbed `$queryRaw` surfaced as
    // "Cannot read properties of undefined (reading 'map')" classified as an
    // unexpected 500, in a test that had nothing to do with raw SQL.
    $executeRaw: jest.fn().mockResolvedValue(0 as never),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0 as never),
    $queryRaw: jest.fn().mockResolvedValue([] as never),
    $queryRawUnsafe: jest.fn().mockResolvedValue([] as never),

    // --- Model delegates ---
    account: mockDelegate(),
    apikey: mockDelegate(),
    auditLog: mockDelegate(),
    category: mockDelegate(),
    categoryGatewayAlias: mockDelegate(),
    designer: mockDelegate(),
    designerGatewayAlias: mockDelegate(),
    event: mockDelegate(),
    eventAttendee: mockDelegate(),
    eventAttendeeGameList: mockDelegate(),
    eventAttendeeRole: mockDelegate(),
    eventAvailabilityVote: mockDelegate(),
    eventCategory: mockDelegate(),
    eventDocument: mockDelegate(),
    eventGame: mockDelegate(),
    eventGameNomination: mockDelegate(),
    eventGameVote: mockDelegate(),
    eventImage: mockDelegate(),
    eventOccurrence: mockDelegate(),
    eventOccurrencePolicy: mockDelegate(),
    eventPolicy: mockDelegate(),
    excludedGame: mockDelegate(),
    family: mockDelegate(),
    familyGatewayAlias: mockDelegate(),
    feedbackReport: mockDelegate(),
    feedbackSubmission: mockDelegate(),
    friendship: mockDelegate(),
    game: mockDelegate(),
    gameArtist: mockDelegate(),
    gameCategory: mockDelegate(),
    gameCollection: mockDelegate(),
    gameDesigner: mockDelegate(),
    gameDlc: mockDelegate(),
    gameDlcGatewayLink: mockDelegate(),
    gameDlcRelease: mockDelegate(),
    gameDocument: mockDelegate(),
    gameExpansion: mockDelegate(),
    gameFamily: mockDelegate(),
    gameGateway: mockDelegate(),
    gameImage: mockDelegate(),
    gameMechanic: mockDelegate(),
    gamePlaySession: mockDelegate(),
    gamePublisher: mockDelegate(),
    gameRelease: mockDelegate(),
    gameReleaseLanguage: mockDelegate(),
    gameSource: mockDelegate(),
    household: mockDelegate(),
    householdMember: mockDelegate(),
    householdPlugin: mockDelegate(),
    householdRole: mockDelegate(),
    invite: mockDelegate(),
    job: mockDelegate(),
    language: mockDelegate(),
    languageGatewayLink: mockDelegate(),
    languageTag: mockDelegate(),
    mechanic: mockDelegate(),
    mechanicGatewayAlias: mockDelegate(),
    media: mockDelegate(),
    mediaContribution: mockDelegate(),
    mediaObject: mockDelegate(),
    mediaShare: mockDelegate(),
    notification: mockDelegate(),
    passkey: mockDelegate(),
    permission: mockDelegate(),
    platform: mockDelegate(),
    platformGame: mockDelegate(),
    platformGatewayLink: mockDelegate(),
    plugin: mockDelegate(),
    pluginGrant: mockDelegate(),
    pluginLifecycleEvent: mockDelegate(),
    pluginPermission: mockDelegate(),
    publisher: mockDelegate(),
    publisherGatewayLink: mockDelegate(),
    quota: mockDelegate(),
    role: mockDelegate(),
    rolePermission: mockDelegate(),
    ruleVariant: mockDelegate(),
    safeHttpPolicy: mockDelegate(),
    session: mockDelegate(),
    sessionPlayer: mockDelegate(),
    systemSetting: mockDelegate(),
    user: mockDelegate(),
    userPermission: mockDelegate(),
    userPlugin: mockDelegate(),
    userPreferences: mockDelegate(),
    userProfile: mockDelegate(),
    userRole: mockDelegate(),
    webhookSubscription: mockDelegate(),
  } as unknown as MockDatabaseService;
}

/**
 * Installs a `$transaction` implementation that handles BOTH Prisma forms:
 * the callback form runs against the mock itself (so writes land on the mock
 * delegates), and the array form resolves positionally.
 *
 * Needed wherever one service does both — `HouseholdService` wraps its writes
 * in a callback transaction and reads its paginated list as
 * `$transaction([findMany, count])` (#230). Stubbing only `(cb) => cb(db)` in a
 * shared `beforeEach` makes the array-form read fail with "cb is not a
 * function", which reads as a mock bug rather than a stubbing gap.
 */
export function unwrapTransaction(db: MockDatabaseService): void {
  db.$transaction.mockImplementation(((operations: unknown) =>
    Array.isArray(operations)
      ? Promise.all(operations)
      : (operations as (tx: MockDatabaseService) => Promise<unknown>)(db)) as never);
}

/**
 * The `(operations, options)` a batch `$transaction` was called with.
 *
 * The mock's `$transaction` is typed for the callback form, so reading the
 * second argument needs a cast; keeping that cast here means a spec asserting an
 * isolation level does not have to carry one. Pinning the options matters
 * because the mock resolves the operation array whatever isolation is asked for
 * — the snapshot guarantee is invisible to a test that only checks the rows.
 */
export function batchTransactionCall(
  db: MockDatabaseService,
  index = 0,
): { operations: unknown[]; options?: { isolationLevel?: unknown } } {
  const call = db.$transaction.mock.calls[index] as unknown as [unknown[], { isolationLevel?: unknown }?];

  return { operations: call[0], options: call[1] };
}
