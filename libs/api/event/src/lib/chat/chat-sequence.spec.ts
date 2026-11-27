import type { Prisma } from '@bge/database';
import type { MockDatabaseService } from '@bge/testing';
import { createMockDatabaseService } from '@bge/testing';
import { nextChatSequence } from './chat-sequence';

const asTx = (mock: MockDatabaseService): Prisma.TransactionClient => mock as unknown as Prisma.TransactionClient;

// The statement's locking and ordering are proven against Postgres in the
// api-e2e suite (event-chat-storage.spec.ts); here only what the function does
// with the row it gets back (#1543).
describe('nextChatSequence', () => {
  let tx: MockDatabaseService;

  beforeEach(() => {
    tx = createMockDatabaseService();
  });

  it('returns the counter the statement hands back', async () => {
    tx.$queryRaw.mockResolvedValue([{ last_sequence: 7 }]);

    await expect(nextChatSequence(asTx(tx), 'event-1')).resolves.toBe(7);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('throws when the statement returns no row', async () => {
    tx.$queryRaw.mockResolvedValue([]);

    await expect(nextChatSequence(asTx(tx), 'event-1')).rejects.toThrow('event-1');
  });
});
