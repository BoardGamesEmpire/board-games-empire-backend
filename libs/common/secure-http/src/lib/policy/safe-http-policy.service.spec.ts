import { type SafeHttpPolicy } from '@bge/database';
import { createTestingModuleWithDb, MockDatabaseService } from '@bge/testing';
import {
  SAFE_HTTP_DEFAULT_MAX_REDIRECTS,
  SAFE_HTTP_DEFAULT_STRICT_MODE,
  SAFE_HTTP_DEFAULT_TIMEOUT_MS,
} from '../constants/safe-http.constants';
import type { SafeHttpPolicyEventHandler } from './safe-http-policy-event.interface';
import { SafeHttpPolicyEventsService } from './safe-http-policy-events.service';
import { SafeHttpPolicyService } from './safe-http-policy.service';

function buildRow(overrides: Partial<SafeHttpPolicy> = {}): SafeHttpPolicy {
  return {
    id: 'policy-1',
    identifier: 'fixture-uuid',
    singleton: true,
    defaultTimeoutMs: 8000,
    defaultMaxRedirects: 3,
    strictMode: false,
    allowedHosts: ['Jenkins.Local'],
    allowedCidrs: ['10.0.0.0/8'],
    blockedHosts: ['blocked.example.com'],
    blockedCidrs: ['203.0.113.0/24'],
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    updatedBy: 'user-1',
    ...overrides,
  } as SafeHttpPolicy;
}

/**
 * Fake events service capturing the handler the policy service registers
 * and exposing a `trigger` to simulate an inbound pub/sub message.
 */
class FakeEventsService {
  handler: SafeHttpPolicyEventHandler | undefined;

  subscribe = jest.fn(async (handler: SafeHttpPolicyEventHandler) => {
    this.handler = handler;
    return async () => undefined;
  });

  publish = jest.fn(async () => undefined);

  async trigger(): Promise<void> {
    if (this.handler) {
      await this.handler({ updatedAt: new Date().toISOString(), updatedBy: 'user-1' });
    }
  }
}

describe('SafeHttpPolicyService', () => {
  let service: SafeHttpPolicyService;
  let db: MockDatabaseService;
  let events: FakeEventsService;

  beforeEach(async () => {
    events = new FakeEventsService();

    const { module, db: dbMock } = await createTestingModuleWithDb({
      providers: [SafeHttpPolicyService, { provide: SafeHttpPolicyEventsService, useValue: events }],
    });

    service = module.get(SafeHttpPolicyService);
    db = dbMock;
  });

  describe('boot (onModuleInit)', () => {
    it('loads the singleton row from DB into the snapshot', async () => {
      db.safeHttpPolicy.findUnique.mockResolvedValue(buildRow());

      await service.onModuleInit();
      const snapshot = service.current();

      expect(snapshot.defaultTimeoutMs).toBe(8000);
      expect(snapshot.defaultMaxRedirects).toBe(3);
      expect(snapshot.strictMode).toBe(false);
      expect(snapshot.allowedCidrs).toEqual(['10.0.0.0/8']);
    });

    it('lowercases hostnames on load', async () => {
      db.safeHttpPolicy.findUnique.mockResolvedValue(buildRow());

      await service.onModuleInit();
      expect(service.current().allowedHosts).toEqual(['jenkins.local']);
    });

    it('falls back to conservative defaults when the row is absent', async () => {
      db.safeHttpPolicy.findUnique.mockResolvedValue(null);

      await service.onModuleInit();
      const snapshot = service.current();

      expect(snapshot.defaultTimeoutMs).toBe(SAFE_HTTP_DEFAULT_TIMEOUT_MS);
      expect(snapshot.defaultMaxRedirects).toBe(SAFE_HTTP_DEFAULT_MAX_REDIRECTS);
      expect(snapshot.strictMode).toBe(SAFE_HTTP_DEFAULT_STRICT_MODE);
      expect(snapshot.allowedHosts).toEqual([]);
      expect(snapshot.allowedCidrs).toEqual([]);
      expect(snapshot.blockedHosts).toEqual([]);
      expect(snapshot.blockedCidrs).toEqual([]);
    });

    it('retains prior snapshot on DB failure (fail-safe)', async () => {
      db.safeHttpPolicy.findUnique.mockRejectedValue(new Error('connection lost'));

      await service.onModuleInit();
      const snapshot = service.current();

      // No prior snapshot — we get the default fallback, not a crash.
      expect(snapshot.allowedHosts).toEqual([]);
      expect(snapshot.allowedCidrs).toEqual([]);
    });

    it('subscribes to the events service on init', async () => {
      db.safeHttpPolicy.findUnique.mockResolvedValue(buildRow());
      await service.onModuleInit();
      expect(events.subscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe('CIDR validation on load', () => {
    it('drops invalid CIDR entries from allowedCidrs and blockedCidrs', async () => {
      db.safeHttpPolicy.findUnique.mockResolvedValue(
        buildRow({
          allowedCidrs: ['10.0.0.0/8', 'not-a-cidr', '192.168.0.0/16'],
          blockedCidrs: ['203.0.113.0/24', 'also-bad/99'],
        }),
      );

      await service.onModuleInit();
      const snapshot = service.current();

      expect(snapshot.allowedCidrs).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
      expect(snapshot.blockedCidrs).toEqual(['203.0.113.0/24']);
    });
  });

  describe('hot reload', () => {
    it('refreshes snapshot when events handler fires', async () => {
      // First load.
      db.safeHttpPolicy.findUnique.mockResolvedValue(buildRow({ defaultTimeoutMs: 8000 }));
      await service.onModuleInit();
      expect(service.current().defaultTimeoutMs).toBe(8000);

      // Admin changes the row; pub/sub message fires.
      db.safeHttpPolicy.findUnique.mockResolvedValue(buildRow({ defaultTimeoutMs: 20_000 }));
      await events.trigger();

      expect(service.current().defaultTimeoutMs).toBe(20_000);
    });

    it('retains existing snapshot when refresh fails mid-flight', async () => {
      db.safeHttpPolicy.findUnique.mockResolvedValue(buildRow({ defaultTimeoutMs: 8000 }));
      await service.onModuleInit();

      db.safeHttpPolicy.findUnique.mockRejectedValue(new Error('transient'));
      await events.trigger();

      // Still on the prior snapshot, not the default fallback.
      expect(service.current().defaultTimeoutMs).toBe(8000);
    });
  });

  describe('snapshot immutability', () => {
    it('returns a frozen snapshot', async () => {
      db.safeHttpPolicy.findUnique.mockResolvedValue(buildRow());
      await service.onModuleInit();
      const snapshot = service.current();

      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.allowedHosts)).toBe(true);
      expect(Object.isFrozen(snapshot.allowedCidrs)).toBe(true);
    });

    it('atomically swaps reference on refresh — readers see one or the other, never partial', async () => {
      db.safeHttpPolicy.findUnique.mockResolvedValue(buildRow({ defaultTimeoutMs: 8000 }));
      await service.onModuleInit();
      const before = service.current();

      db.safeHttpPolicy.findUnique.mockResolvedValue(buildRow({ defaultTimeoutMs: 20_000 }));
      await events.trigger();
      const after = service.current();

      expect(before).not.toBe(after);
      expect(before.defaultTimeoutMs).toBe(8000); // old reference unchanged
      expect(after.defaultTimeoutMs).toBe(20_000);
    });
  });
});
