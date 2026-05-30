import { DatabaseService } from '@bge/database';
import { Provider } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import { PrismaHealthIndicator } from './prisma.health-indicator';

type DbQueryRaw = DatabaseService['$queryRaw'];
type MockDb = { $queryRaw: jest.MockedFunction<DbQueryRaw> };

async function buildIndicator(db: MockDb) {
  const providers: Provider[] = [PrismaHealthIndicator, { provide: DatabaseService, useValue: db }];

  const module = await Test.createTestingModule({
    imports: [TerminusModule],
    providers,
  }).compile();

  return module.get(PrismaHealthIndicator);
}

function makeMockDb(): MockDb {
  return {
    $queryRaw: jest.fn() as jest.MockedFunction<DbQueryRaw>,
  };
}

describe('PrismaHealthIndicator', () => {
  let db: MockDb;

  beforeEach(() => {
    db = makeMockDb();
  });

  describe('healthy path', () => {
    it('returns up when $queryRaw resolves', async () => {
      db.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      const indicator = await buildIndicator(db);

      const result = await indicator.isHealthy('database');

      expect(result).toEqual({ database: { status: 'up' } });
    });

    it('uses the provided key in the result', async () => {
      db.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      const indicator = await buildIndicator(db);

      const result = await indicator.isHealthy('primary-db');

      expect(result).toEqual({ 'primary-db': { status: 'up' } });
    });

    it('defaults the key to "database" when none is provided', async () => {
      db.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      const indicator = await buildIndicator(db);

      const result = await indicator.isHealthy();

      expect(result).toEqual({ database: { status: 'up' } });
    });

    it('executes exactly one query per check', async () => {
      db.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      const indicator = await buildIndicator(db);

      await indicator.isHealthy();

      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('unhealthy paths', () => {
    it('returns down with the error message when $queryRaw rejects with an Error', async () => {
      db.$queryRaw.mockRejectedValue(new Error('connection refused'));
      const indicator = await buildIndicator(db);

      const result = await indicator.isHealthy('database');

      expect(result).toEqual({
        database: { status: 'down', message: 'connection refused' },
      });
    });

    it('handles non-Error rejection values', async () => {
      db.$queryRaw.mockRejectedValue('catastrophic failure');
      const indicator = await buildIndicator(db);

      const result = await indicator.isHealthy('database');

      expect(result).toEqual({
        database: { status: 'down', message: 'catastrophic failure' },
      });
    });

    it('uses the provided key in down results', async () => {
      db.$queryRaw.mockRejectedValue(new Error('down'));
      const indicator = await buildIndicator(db);

      const result = await indicator.isHealthy('primary-db');

      expect(result).toEqual({
        'primary-db': { status: 'down', message: 'down' },
      });
    });

    it('does not throw — indicator returns the down result for HealthCheckService to aggregate', async () => {
      db.$queryRaw.mockRejectedValue(new Error('boom'));
      const indicator = await buildIndicator(db);

      await expect(indicator.isHealthy('database')).resolves.toBeDefined();
    });
  });
});
