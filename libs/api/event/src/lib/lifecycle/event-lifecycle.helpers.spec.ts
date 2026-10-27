import type { Prisma } from '@bge/database';
import { t } from '@bge/i18n';
import { createMockDatabaseService, rawQueryText, type MockDatabaseService } from '@bge/testing';
import { BadRequestException } from '@nestjs/common';
import { assertEventNotCancelled } from './event-lifecycle.helpers';

const asTx = (mock: MockDatabaseService): Prisma.TransactionClient => mock as unknown as Prisma.TransactionClient;

describe('assertEventNotCancelled', () => {
  let tx: MockDatabaseService;

  beforeEach(() => {
    tx = createMockDatabaseService();
  });

  // FOR SHARE conflicts with the FOR NO KEY UPDATE a cancel holds, so a date
  // write and a cancel take turns, and whichever comes second sees the first.
  it("reads the event's cancel under a share lock (#795)", async () => {
    tx.$queryRaw.mockResolvedValue([{ cancelledAt: null }]);

    await assertEventNotCancelled(asTx(tx), 'event-1');

    const [[query]] = tx.$queryRaw.mock.calls;
    expect(rawQueryText(query)).toMatch(/^SELECT cancelled_at AS "cancelledAt" FROM events WHERE id = \? FOR SHARE$/);
    expect((query as unknown as Prisma.Sql).values).toEqual(['event-1']);
  });

  it('lets a write go ahead on an event not cancelled (#795)', async () => {
    tx.$queryRaw.mockResolvedValue([{ cancelledAt: null }]);

    await expect(assertEventNotCancelled(asTx(tx), 'event-1')).resolves.toBeUndefined();
  });

  it('refuses with 400 on a cancelled event: reopen it first (#795)', async () => {
    tx.$queryRaw.mockResolvedValue([{ cancelledAt: new Date() }]);

    const rejection: unknown = await assertEventNotCancelled(asTx(tx), 'event-1').catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(BadRequestException);
    expect((rejection as BadRequestException).getResponse()).toEqual(t('errors.event.cancelled'));
  });

  // Whether the event exists is the caller's to answer, with its own 404.
  it('leaves a missing event to the caller (#795)', async () => {
    tx.$queryRaw.mockResolvedValue([]);

    await expect(assertEventNotCancelled(asTx(tx), 'event-1')).resolves.toBeUndefined();
  });
});
