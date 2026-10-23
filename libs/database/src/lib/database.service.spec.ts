import { env } from '@bge/env';
import { Logger, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { get, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseService } from './database.service';

jest.mock('./client', () => {
  class MockPrismaClient {
    // The options the service handed to `super()`, so a test can read the
    // `log` setting that Prisma would act on.
    static lastOptions: { log?: unknown[] } | undefined;

    constructor(options?: { log?: unknown[] }) {
      MockPrismaClient.lastOptions = options;
    }

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

/**
 * Mounts a route that holds its request open until the test releases it, so a
 * test can close the app while a request is still in flight.
 */
const holdOneRequest = (app: INestApplication) => {
  let release!: () => void;
  let markArrived!: () => void;
  const arrived = new Promise<void>((resolve) => (markArrived = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));

  app.getHttpAdapter().get('/held', (_req: IncomingMessage, res: ServerResponse) => {
    markArrived();
    void released.then(() => res.end('done'));
  });

  return { arrived, release };
};

// No keep-alive agent, so the connection ends with the response.
const getBody = (port: number, path: string) =>
  new Promise<string>((resolve, reject) => {
    get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });

const lastPrismaOptions = () =>
  (jest.requireMock('./client') as { PrismaClient: { lastOptions: { log?: unknown[] } } }).PrismaClient.lastOptions;

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('DatabaseService', () => {
  let module: TestingModule;
  let service: DatabaseService;

  const mockGetOrThrow = jest.fn<string, [string]>().mockReturnValue('postgresql://localhost:5432/test');
  const mockGet = jest.fn<string | undefined, [string]>().mockReturnValue(undefined);

  const compileModule = (get: typeof mockGet) =>
    Test.createTestingModule({
      providers: [
        DatabaseService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: mockGetOrThrow,
            get,
          } satisfies Pick<ConfigService, 'getOrThrow' | 'get'>,
        },
      ],
    }).compile();

  /**
   * The service reads `database.logQueries` in its constructor, because the
   * `log` option is fixed at `super()`, so a test sets the flag by building a
   * fresh service.
   */
  const createService = async ({ logQueries = false }: { logQueries?: boolean } = {}) => {
    const get = jest.fn((key: string) => (key === 'database.logQueries' ? logQueries : undefined));
    const compiled = await compileModule(get as unknown as typeof mockGet);
    return compiled.get<DatabaseService>(DatabaseService);
  };

  beforeEach(async () => {
    module = await compileModule(mockGet);

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
  });

  describe('Prisma log events', () => {
    const handlerFor = (target: DatabaseService, level: string) => {
      const call = (target.$on as jest.Mock).mock.calls.find(([name]) => name === level);
      return call?.[1] as (event: unknown) => void;
    };
    const event = (message: string) => ({ message, target: 'x', timestamp: new Date() });

    afterEach(() => jest.restoreAllMocks());

    it('asks Prisma for error events, not console output, in production (#627)', async () => {
      jest.spyOn(env, 'isDevelopment', 'get').mockReturnValue(false);

      await createService();

      expect(lastPrismaOptions().log).toEqual([{ emit: 'event', level: 'error' }]);
    });

    it('asks Prisma for info and warn events too in development, and queries only on request (#627)', async () => {
      jest.spyOn(env, 'isDevelopment', 'get').mockReturnValue(true);

      await createService();
      expect(lastPrismaOptions().log).toEqual([
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'info' },
      ]);

      await createService({ logQueries: true });
      expect(lastPrismaOptions().log).toContainEqual({ emit: 'event', level: 'query' });
    });

    it('does not ask for query events when database.logQueries is off, even in development (#627)', async () => {
      jest.spyOn(env, 'isDevelopment', 'get').mockReturnValue(true);

      await createService({ logQueries: false });

      expect(lastPrismaOptions().log).not.toContainEqual({ emit: 'event', level: 'query' });
    });

    it('registers a query listener when database.logQueries is true', async () => {
      const queryService = await createService({ logQueries: true });

      expect(queryService.$on).toHaveBeenCalledWith('query', expect.any(Function));
    });

    it('does not register a query listener when database.logQueries is absent', () => {
      expect(service.$on).not.toHaveBeenCalledWith('query', expect.any(Function));
    });

    it('listens for every requested level from construction, before $connect can emit one (#627)', async () => {
      // With `emit: 'event'` Prisma prints nothing itself, so an event emitted
      // before its listener exists is lost.
      jest.spyOn(env, 'isDevelopment', 'get').mockReturnValue(true);

      const devService = await createService({ logQueries: true });

      const listened = (devService.$on as jest.Mock).mock.calls.map(([level]) => level);
      const requested = (lastPrismaOptions().log as Array<{ level: string }>).map(({ level }) => level);
      expect(listened).toEqual(requested);
      expect(devService.$connect).not.toHaveBeenCalled();
    });

    it('logs a Prisma error event as one error record (#627)', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const message = 'Raw query failed. Code: `42P01`. Message: `relation "x" does not exist`';

      handlerFor(service, 'error')(event(message));

      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(message);
    });

    it('logs Prisma warn and info events as one record each (#627)', async () => {
      jest.spyOn(env, 'isDevelopment', 'get').mockReturnValue(true);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const devService = await createService();
      log.mockClear();

      handlerFor(devService, 'warn')(event('a warning'));
      handlerFor(devService, 'info')(event('some info'));

      expect(warn).toHaveBeenCalledWith('a warning');
      expect(log).toHaveBeenCalledWith('some info');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('logs the query and its duration', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const queryService = await createService({ logQueries: true });
      log.mockClear();

      handlerFor(
        queryService,
        'query',
      )({
        query: 'SELECT 1',
        params: '[]',
        duration: 3,
        target: 'x',
        timestamp: new Date(),
      });

      expect(log).toHaveBeenCalledWith(expect.stringContaining('SELECT 1'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('3ms'));
    });

    it('logs no query parameters, which can carry session tokens (#627)', async () => {
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(),
      );
      const queryService = await createService({ logQueries: true });

      handlerFor(
        queryService,
        'query',
      )({
        query: 'SELECT * FROM "session" WHERE token = $1',
        params: '["token-secret"]',
        duration: 1,
        target: 'x',
        timestamp: new Date(),
      });

      const logged = spies.flatMap((spy) => spy.mock.calls).map((args) => JSON.stringify(args));
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.filter((line) => line.includes('token-secret'))).toEqual([]);
    });
  });

  describe('onApplicationShutdown', () => {
    it('calls $disconnect exactly once', async () => {
      await service.onApplicationShutdown();

      expect(service.$disconnect).toHaveBeenCalledTimes(1);
    });

    it('ends the owned pool after disconnecting', async () => {
      const pool = getPool(service);

      await service.onApplicationShutdown();

      expect(service.$disconnect).toHaveBeenCalledTimes(1);
      expect(pool.end).toHaveBeenCalledTimes(1);
      // Disconnect Prisma before tearing down the pool it was using.
      const disconnectOrder = (service.$disconnect as jest.Mock).mock.invocationCallOrder[0];
      const endOrder = pool.end.mock.invocationCallOrder[0];
      expect(disconnectOrder).toBeLessThan(endOrder);
    });
  });

  describe('shutdown order', () => {
    it('ends the pool only after an in-flight request has finished', async () => {
      const app = module.createNestApplication({ logger: false });
      const { arrived, release } = holdOneRequest(app);
      await app.listen(0, '127.0.0.1');
      const server = app.getHttpServer() as Server;
      const pool = getPool(app.get(DatabaseService));

      const response = getBody((server.address() as AddressInfo).port, '/held');
      await arrived;
      const closing = app.close();
      await flush();

      try {
        // close() has stopped the server and is waiting on the open request.
        expect(server.listening).toBe(false);
        expect(pool.end).not.toHaveBeenCalled();
      } finally {
        // A failed assertion must still let close() finish, or Jest never exits.
        release();
      }
      await expect(response).resolves.toBe('done');
      await closing;

      expect(pool.end).toHaveBeenCalledTimes(1);
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
