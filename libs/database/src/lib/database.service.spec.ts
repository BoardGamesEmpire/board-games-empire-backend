import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseService } from './database.service';

jest.mock('./client', () => {
  class MockPrismaClient {
    $connect = jest.fn().mockResolvedValue(undefined);
    $disconnect = jest.fn().mockResolvedValue(undefined);
    $extends = jest.fn();
    $on = jest.fn();
  }
  return {
    PrismaClient: MockPrismaClient,
    // Re-export the Prisma namespace stub so imports like `Prisma.QueryEvent`
    // resolve without hitting the generated files.
    Prisma: {},
  };
});

jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation(() => ({})),
}));

// Mock the pg pool so the service constructs a deterministic, offline
// pool. node-postgres connects lazily, but mocking keeps the test free of
// any real handles and lets us assert pool lifecycle + gauge reads.
jest.mock('pg', () => {
  class MockPool {
    public totalCount = 7;
    public idleCount = 2;
    public waitingCount = 1;
    public options = { max: 10 };
    public end = jest.fn().mockResolvedValue(undefined);
  }
  return { Pool: MockPool };
});

interface MockPoolInstance {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  options: { max: number };
  end: jest.Mock<Promise<void>, []>;
}

const getPool = (service: DatabaseService): MockPoolInstance =>
  (service as unknown as { readonly pool: MockPoolInstance }).pool;

describe('DatabaseService', () => {
  let module: TestingModule;
  let service: DatabaseService;

  const mockGetOrThrow = jest.fn<string, [string]>().mockReturnValue('postgresql://localhost:5432/test');
  const mockGet = jest.fn<string | undefined, [string]>().mockReturnValue(undefined);

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        DatabaseService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: mockGetOrThrow,
            get: mockGet,
          } satisfies Pick<ConfigService, 'getOrThrow' | 'get'>,
        },
      ],
    }).compile();

    service = module.get<DatabaseService>(DatabaseService);
  });

  afterEach(() => jest.clearAllMocks());

  afterAll(() => module.close());

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('calls $connect exactly once', async () => {
      await service.onModuleInit();

      expect(service.$connect).toHaveBeenCalledTimes(1);
    });

    it('rethrows errors from $connect', async () => {
      const cause = new Error('ECONNREFUSED');
      jest.spyOn(service, '$connect').mockRejectedValue(cause);

      await expect(service.onModuleInit()).rejects.toThrow('ECONNREFUSED');
    });

    it('registers a query listener when database.logQueries is truthy', async () => {
      mockGet.mockReturnValue('true');

      await service.onModuleInit();

      expect(service.$on).toHaveBeenCalledWith('query', expect.any(Function));
    });

    it('does not register a query listener when database.logQueries is absent', async () => {
      mockGet.mockReturnValue(undefined);

      await service.onModuleInit();

      expect(service.$on).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('calls $disconnect exactly once', async () => {
      await service.onModuleDestroy();

      expect(service.$disconnect).toHaveBeenCalledTimes(1);
    });

    it('ends the owned pool after disconnecting', async () => {
      const pool = getPool(service);

      await service.onModuleDestroy();

      expect(service.$disconnect).toHaveBeenCalledTimes(1);
      expect(pool.end).toHaveBeenCalledTimes(1);
      // Disconnect Prisma before tearing down the pool it was using.
      const disconnectOrder = (service.$disconnect as jest.Mock).mock.invocationCallOrder[0];
      const endOrder = pool.end.mock.invocationCallOrder[0];
      expect(disconnectOrder).toBeLessThan(endOrder);
    });
  });

  describe('getDatabasePoolMetrics', () => {
    it('maps the pg pool gauges onto the snapshot shape', () => {
      const pool = getPool(service);
      pool.totalCount = 7;
      pool.idleCount = 2;
      pool.waitingCount = 1;
      pool.options.max = 10;

      expect(service.getDatabasePoolMetrics()).toEqual({
        open: 7,
        busy: 5, // total - idle
        idle: 2,
        pending: 1,
        max: 10,
      });
    });

    it('reflects live pool changes on each read', () => {
      const pool = getPool(service);

      pool.totalCount = 10;
      pool.idleCount = 0;
      pool.waitingCount = 4;

      expect(service.getDatabasePoolMetrics()).toMatchObject({ open: 10, busy: 10, idle: 0, pending: 4 });
    });
  });
});
