import type { AuditContextService, SystemActorScope } from '@bge/actor-context';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { Logger } from '@nestjs/common';
import type { InviteService } from '../invite.service';
import { InviteExpirySweepService } from './sweep.service';

const BATCH = 500;

describe('InviteExpirySweepService', () => {
  /** The transaction client each batch runs on, distinct from the service's own connection. */
  const tx = { name: 'the batch transaction' };

  let db: MockDatabaseService;
  let invites: { expireOutstandingWithin: jest.Mock; emit: jest.Mock };
  let audit: { getActorOrThrow: jest.Mock };
  let systemActorScope: { run: jest.Mock };
  let logged: jest.SpyInstance;
  let service: InviteExpirySweepService;
  /** What happened, in order: each transaction's begin and commit, each expiry, each emit. */
  let log: string[];

  type Batch = { count: number; drained: boolean };
  /** A batch with a status whose read came back full, so there may be more. */
  const full = (count: number): Batch => ({ count, drained: false });
  /** A batch whose reads all came back short, so nothing overdue was left. */
  const last = (count: number): Batch => ({ count, drained: true });
  /** The expiry's result for a batch, with one stand-in domain event per row. */
  const result = ({ count, drained }: Batch) => ({
    count,
    drained,
    events: Array.from({ length: count }, (_, i) => ({ subjectId: `inv-${count}-${i}` })),
  });

  const expiring = (...batches: Batch[]) => {
    for (const batch of batches) {
      invites.expireOutstandingWithin.mockImplementationOnce(async () => {
        log.push(`expire ${batch.count}`);
        return result(batch);
      });
    }
  };

  /** A batch that waits for the test to finish it, to stand in for one in flight. */
  const inFlight = () => {
    let finish!: (outcome: Batch | Error) => void;
    invites.expireOutstandingWithin.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = (outcome) => {
            if (outcome instanceof Error) {
              log.push('expire fails');
              reject(outcome);
            } else {
              log.push(`expire ${outcome.count}`);
              resolve(result(outcome));
            }
          };
        }),
    );

    return (outcome: Batch | Error) => finish(outcome);
  };

  /** Lets every pending promise callback run. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    log = [];
    db = createMockDatabaseService();
    db.$transaction.mockImplementation(async (fn) => {
      log.push('begin');
      const result = await fn(tx as never);
      log.push('commit');
      return result;
    });
    invites = {
      expireOutstandingWithin: jest.fn(),
      emit: jest.fn((events: readonly unknown[]) => log.push(`emit ${events.length}`)),
    };
    audit = { getActorOrThrow: jest.fn().mockReturnValue({ kind: 'system', reason: 'invite-expiry-sweep' }) };
    systemActorScope = { run: jest.fn((_reason: string, fn: () => unknown) => fn()) };
    service = new InviteExpirySweepService(
      db as never,
      invites as unknown as InviteService,
      audit as unknown as AuditContextService,
      systemActorScope as unknown as SystemActorScope,
    );
    logged = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('runs as the system actor, named for the sweep, with its announcements inside the scope', async () => {
    let inScope = false;
    const emittedInScope: boolean[] = [];
    systemActorScope.run.mockImplementation(async (_reason: string, fn: () => Promise<unknown>) => {
      inScope = true;

      try {
        return await fn();
      } finally {
        inScope = false;
      }
    });
    invites.emit.mockImplementation(() => emittedInScope.push(inScope));
    expiring(last(3));

    await service.sweepOnInterval();

    // The audit listener reads the actor when the domain event is emitted, so
    // an emit outside the scope would be recorded without one.
    expect(systemActorScope.run).toHaveBeenCalledWith('invite-expiry-sweep', expect.any(Function));
    expect(emittedInScope).toEqual([true]);
  });

  it('expires each batch in its own transaction and announces it only after that transaction commits', async () => {
    expiring(full(BATCH), full(BATCH), last(7));

    await expect(service.runSweep()).resolves.toEqual({ expired: 2 * BATCH + 7 });

    expect(log).toEqual([
      ...['begin', `expire ${BATCH}`, 'commit', `emit ${BATCH}`],
      ...['begin', `expire ${BATCH}`, 'commit', `emit ${BATCH}`],
      ...['begin', 'expire 7', 'commit', 'emit 7'],
    ]);
    expect(invites.expireOutstandingWithin).toHaveBeenCalledTimes(3);
    for (const call of invites.expireOutstandingWithin.mock.calls) {
      expect(call).toEqual([tx, { limit: BATCH }]);
    }
    // Each emit carries the batch it followed, not a running total.
    expect(invites.emit.mock.calls.map(([events]) => events.length)).toEqual([BATCH, BATCH, 7]);
  });

  it.each([
    { case: 'nothing overdue', batches: [last(0)], transactions: 1 },
    { case: 'one short batch', batches: [last(BATCH - 1)], transactions: 1 },
    { case: 'a full batch, then nothing', batches: [full(BATCH), last(0)], transactions: 2 },
    // A rival settled one of a full read's rows: fewer than the limit moved,
    // and the rest of the backlog is still there.
    { case: 'a full read a rival left short', batches: [full(BATCH - 1), last(3)], transactions: 2 },
    // Both reads short, though together over the limit: no empty batch after.
    { case: 'two short reads over the limit', batches: [last(BATCH + 100)], transactions: 1 },
  ])('stops at the first drained batch: $case', async ({ batches, transactions }) => {
    expiring(...batches);

    await service.runSweep();

    expect(db.$transaction).toHaveBeenCalledTimes(transactions);
  });

  it('ends the run at a failed batch, keeping what the earlier batches committed and announced', async () => {
    expiring(full(BATCH));
    invites.expireOutstandingWithin.mockImplementationOnce(async () => {
      log.push('expire fails');
      throw new Error('deadlock detected');
    });

    // Thrown to the scheduler, which logs it; the next run picks up the rest.
    await expect(service.runSweep()).rejects.toThrow('deadlock detected');

    expect(log).toEqual(['begin', `expire ${BATCH}`, 'commit', `emit ${BATCH}`, 'begin', 'expire fails']);
    // The scheduler logs only the error, so the run says what it did commit.
    expect(logged).toHaveBeenCalledWith(`Invite expiry sweep expired ${BATCH} invite(s)`);
  });

  it('refuses to run outside an actor scope, before touching anything', async () => {
    // Every invite.expired would otherwise be audited with no actor.
    audit.getActorOrThrow.mockImplementation(() => {
      throw new Error('AuditContextService.getActorOrThrow called outside a populated CLS scope');
    });

    await expect(service.runSweep()).rejects.toThrow('outside a populated CLS scope');

    expect(db.$transaction).not.toHaveBeenCalled();
    expect(invites.emit).not.toHaveBeenCalled();
  });

  describe('at shutdown', () => {
    // The audit listener detaches, and the pool ends, in onApplicationShutdown,
    // which Nest runs only once every beforeApplicationShutdown has resolved.

    it('lets the batch in flight commit and announce first, and starts no other', async () => {
      const finish = inFlight();
      const run = service.runSweep();
      await settle();

      const shutdown = service.beforeApplicationShutdown().then(() => log.push('shut down'));
      await settle();
      expect(log).toEqual(['begin']);

      // More remains, yet no second batch starts.
      finish(full(BATCH));
      await expect(run).resolves.toEqual({ expired: BATCH });
      await shutdown;

      expect(log).toEqual(['begin', `expire ${BATCH}`, 'commit', `emit ${BATCH}`, 'shut down']);
    });

    it('still finishes when the batch in flight fails', async () => {
      const finish = inFlight();
      const run = service.runSweep();
      await settle();

      const shutdown = service.beforeApplicationShutdown();
      finish(new Error('deadlock detected'));

      await expect(run).rejects.toThrow('deadlock detected');
      await expect(shutdown).resolves.toBeUndefined();
    });

    it('turns away a run that starts after it began', async () => {
      await service.beforeApplicationShutdown();

      await expect(service.runSweep()).resolves.toEqual({ expired: 0 });

      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });
});
