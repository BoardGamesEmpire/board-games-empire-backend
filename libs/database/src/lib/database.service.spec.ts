import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseService } from './database.service';

jest.mock('./client', () => {
  class MockPrismaClient {
    $connect = jest.fn().mockResolvedValue(undefined);
    $disconnect = jest.fn().mockResolvedValue(undefined);
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
  });
});
