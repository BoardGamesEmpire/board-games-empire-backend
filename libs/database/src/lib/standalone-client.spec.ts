import { PrismaClient } from './client';
import { openStandaloneClient } from './standalone-client';

jest.mock('pg', () => ({ Pool: jest.fn() }));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: jest.fn() }));
jest.mock('./client', () => ({ PrismaClient: jest.fn() }));

// The client's construction is exercised against a real database by the e2e
// harness, which opens every DB-only spec through it. This covers the one
// promise `close()` makes that a live database never tests: both resources go.

describe('openStandaloneClient', () => {
  it('close() ends the pool when Prisma refuses to disconnect, and still reports the refusal', async () => {
    const end = jest.fn().mockResolvedValue(undefined);
    const disconnect = jest.fn().mockRejectedValue(new Error('engine already gone'));
    jest.mocked(PrismaClient).mockImplementation(() => ({ $disconnect: disconnect }) as unknown as PrismaClient);
    const { Pool } = jest.requireMock<{ Pool: jest.Mock }>('pg');
    Pool.mockImplementation(() => ({ end }));

    const client = openStandaloneClient('postgresql://u:p@localhost:5432/db?schema=bge');

    await expect(client.close()).rejects.toThrow('engine already gone');
    expect(end).toHaveBeenCalledTimes(1);
  });
});
