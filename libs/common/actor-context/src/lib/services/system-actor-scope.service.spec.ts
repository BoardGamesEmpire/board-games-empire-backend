import { firstValueFrom, of, throwError } from 'rxjs';
import { toArray } from 'rxjs/operators';
import type { ActorContextInit, AuditContextInternalService } from './audit-context-internal.service';
import { SystemActorScope } from './system-actor-scope.service';

interface MockAuditContext {
  runWith: jest.Mock<unknown, [ActorContextInit, () => unknown]>;
}

/**
 * Mock that calls fn() inline so tests can assert on the init argument
 * AND verify result propagation in a single setup. Real CLS scoping is
 * covered by `AuditContextInternalService`'s own spec.
 */
const buildMockAuditContext = (): MockAuditContext => ({
  runWith: jest.fn((_init: ActorContextInit, fn: () => unknown) => fn()),
});

const buildScope = (
  audit: MockAuditContext = buildMockAuditContext(),
): { scope: SystemActorScope; audit: MockAuditContext } => ({
  scope: new SystemActorScope(audit as unknown as AuditContextInternalService),
  audit,
});

const initOf = (audit: MockAuditContext, callIndex = 0): ActorContextInit => audit.runWith.mock.calls[callIndex][0];

describe('SystemActorScope', () => {
  describe('run — init construction', () => {
    it('mints a system actor with the supplied reason', () => {
      const { scope, audit } = buildScope();

      scope.run('cleanup-stale-sessions', () => undefined);

      expect(initOf(audit).actor).toEqual({
        kind: 'system',
        reason: 'cleanup-stale-sessions',
      });
    });

    it('sets source to "system"', () => {
      const { scope, audit } = buildScope();

      scope.run('some-reason', () => undefined);

      expect(initOf(audit).source).toBe('system');
    });

    it('generates a non-empty correlation ID', () => {
      const { scope, audit } = buildScope();

      scope.run('some-reason', () => undefined);

      expect(initOf(audit).correlationId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('generates a different correlation ID on each call', () => {
      const { scope, audit } = buildScope();

      scope.run('r-1', () => undefined);
      scope.run('r-2', () => undefined);
      scope.run('r-3', () => undefined);

      const ids = [initOf(audit, 0).correlationId, initOf(audit, 1).correlationId, initOf(audit, 2).correlationId];
      expect(new Set(ids).size).toBe(3);
    });
  });

  describe('run — return value', () => {
    it('returns the sync result of fn', () => {
      const { scope } = buildScope();

      const result = scope.run('reason', () => 42);

      expect(result).toBe(42);
    });

    it('returns the resolved value of an async fn', async () => {
      const { scope } = buildScope();

      const result = await scope.run('reason', async () => 'async-result');

      expect(result).toBe('async-result');
    });

    it('propagates a synchronous throw from fn', () => {
      const { scope } = buildScope();

      expect(() =>
        scope.run('reason', () => {
          throw new Error('boom');
        }),
      ).toThrow('boom');
    });

    it('propagates rejection from an async fn', async () => {
      const { scope } = buildScope();

      await expect(
        scope.run('reason', async () => {
          throw new Error('async-boom');
        }),
      ).rejects.toThrow('async-boom');
    });

    it('invokes auditContext.runWith exactly once per run call', () => {
      const { scope, audit } = buildScope();

      scope.run('r-1', () => undefined);
      scope.run('r-2', () => undefined);

      expect(audit.runWith).toHaveBeenCalledTimes(2);
    });
  });

  describe('runObservable — laziness', () => {
    it('does NOT call auditContext.runWith until the Observable is subscribed', () => {
      const { scope, audit } = buildScope();
      const fn = jest.fn(() => of('result'));

      scope.runObservable('reason', fn);

      expect(audit.runWith).not.toHaveBeenCalled();
      expect(fn).not.toHaveBeenCalled();
    });

    it('does NOT call the factory until subscription', () => {
      const { scope } = buildScope();
      const fn = jest.fn(() => of('result'));

      scope.runObservable('reason', fn);

      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('runObservable — scope ordering', () => {
    it('calls the factory INSIDE the runWith callback', () => {
      const callOrder: string[] = [];
      const audit: MockAuditContext = {
        runWith: jest.fn((_init, fn) => {
          callOrder.push('runWith-entered');
          const result = fn();
          callOrder.push('runWith-exited');
          return result;
        }),
      };
      const { scope } = buildScope(audit);
      const fn = jest.fn(() => {
        callOrder.push('fn-called');
        return of('result');
      });

      scope.runObservable('reason', fn).subscribe();

      expect(callOrder).toEqual(['runWith-entered', 'fn-called', 'runWith-exited']);
    });
  });

  describe('runObservable — per-subscription freshness', () => {
    it('calls runWith once per subscription', () => {
      const { scope, audit } = buildScope();
      const observable = scope.runObservable('reason', () => of('result'));

      observable.subscribe();
      observable.subscribe();
      observable.subscribe();

      expect(audit.runWith).toHaveBeenCalledTimes(3);
    });

    it('generates a fresh correlation ID per subscription', () => {
      const { scope, audit } = buildScope();
      const observable = scope.runObservable('reason', () => of('result'));

      observable.subscribe();
      observable.subscribe();

      const id1 = initOf(audit, 0).correlationId;
      const id2 = initOf(audit, 1).correlationId;
      expect(id1).not.toBe(id2);
    });
  });

  describe('runObservable — value propagation', () => {
    it('emits values from the inner Observable', async () => {
      const { scope } = buildScope();
      const observable = scope.runObservable('reason', () => of('a', 'b', 'c'));

      const values = await firstValueFrom(observable.pipe(toArray()));

      expect(values).toEqual(['a', 'b', 'c']);
    });

    it('propagates errors from the inner Observable', async () => {
      const { scope } = buildScope();
      const observable = scope.runObservable('reason', () => throwError(() => new Error('rx-boom')));

      await expect(firstValueFrom(observable)).rejects.toThrow('rx-boom');
    });
  });

  describe('runObservable — init construction', () => {
    it('mints a system actor with the supplied reason at subscription time', () => {
      const { scope, audit } = buildScope();

      scope.runObservable('coordinator-ping', () => of('pong')).subscribe();

      expect(initOf(audit).actor).toEqual({
        kind: 'system',
        reason: 'coordinator-ping',
      });
      expect(initOf(audit).source).toBe('system');
    });
  });
});
