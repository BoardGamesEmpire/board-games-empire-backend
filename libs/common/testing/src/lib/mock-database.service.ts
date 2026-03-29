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
 */
export type MockDatabaseService = MockedMethods<
  Pick<
    DatabaseService,
    | '$connect'
    | '$disconnect'
    | '$transaction'
    | '$executeRaw'
    | '$executeRawUnsafe'
    | '$queryRaw'
    | '$queryRawUnsafe'
    | 'account'
    | 'apikey'
    | 'category'
    | 'designer'
    | 'event'
    | 'eventAttendee'
    | 'eventAttendeeRole'
    | 'excludedGame'
    | 'family'
    | 'game'
    | 'gameCollection'
    | 'gameGateway'
    | 'gamePlaySession'
    | 'gameSource'
    | 'household'
    | 'householdMember'
    | 'householdRole'
    | 'invite'
    | 'job'
    | 'language'
    | 'mechanic'
    | 'passkey'
    | 'permission'
    | 'publisher'
    | 'role'
    | 'rolePermission'
    | 'ruleVariant'
    | 'session'
    | 'sessionPlayer'
    | 'systemSetting'
    | 'user'
    | 'userPermission'
    | 'userRole'
    | 'userPreferences'
    | 'userProfile'
  >
>;

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
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    $executeRawUnsafe: jest.fn(),
    $queryRaw: jest.fn(),
    $queryRawUnsafe: jest.fn(),

    // --- Model delegates ---
    account: mockDelegate(),
    apikey: mockDelegate(),
    category: mockDelegate(),
    designer: mockDelegate(),
    event: mockDelegate(),
    eventAttendee: mockDelegate(),
    eventAttendeeRole: mockDelegate(),
    excludedGame: mockDelegate(),
    family: mockDelegate(),
    game: mockDelegate(),
    gameCollection: mockDelegate(),
    gameGateway: mockDelegate(),
    gamePlaySession: mockDelegate(),
    gameSource: mockDelegate(),
    household: mockDelegate(),
    householdMember: mockDelegate(),
    householdRole: mockDelegate(),
    invite: mockDelegate(),
    job: mockDelegate(),
    language: mockDelegate(),
    mechanic: mockDelegate(),
    passkey: mockDelegate(),
    permission: mockDelegate(),
    publisher: mockDelegate(),
    role: mockDelegate(),
    rolePermission: mockDelegate(),
    ruleVariant: mockDelegate(),
    session: mockDelegate(),
    sessionPlayer: mockDelegate(),
    systemSetting: mockDelegate(),
    user: mockDelegate(),
    userPermission: mockDelegate(),
    userRole: mockDelegate(),
    userPreferences: mockDelegate(),
    userProfile: mockDelegate(),
  } as unknown as MockDatabaseService;
}
