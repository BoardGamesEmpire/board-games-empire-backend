import { AuditContextService, type Actor } from '@bge/actor-context';
import { type SafeHttpPolicy } from '@bge/database';
import { SafeHttpPolicyEventsService } from '@bge/secure-http';
import { createTestingModuleWithDb, MockDatabaseService } from '@bge/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { UpdateSafeHttpPolicyDto } from './dto/update-safe-http-policy.dto';
import { SafeHttpService } from './safe-http.service';

function buildRow(overrides: Partial<SafeHttpPolicy> = {}): SafeHttpPolicy {
  return {
    id: 'policy-1',
    singleton: true,
    defaultTimeoutMs: 10_000,
    defaultMaxRedirects: 5,
    strictMode: true,
    allowedHosts: [],
    allowedCidrs: [],
    blockedHosts: [],
    blockedCidrs: [],
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    updatedBy: null,
    ...overrides,
  } satisfies SafeHttpPolicy;
}

const userActor: Actor = {
  kind: 'user',
  userId: 'user-1',
  // Other actor fields would normally be populated; tests only exercise userId.
} as Actor;

describe('SafeHttpService (api)', () => {
  let service: SafeHttpService;
  let db: MockDatabaseService;
  let events: jest.Mocked<Pick<SafeHttpPolicyEventsService, 'publish'>>;
  let audit: { getActorOrThrow: jest.Mock<Actor> };

  beforeEach(async () => {
    events = { publish: jest.fn().mockResolvedValue(undefined) };
    audit = { getActorOrThrow: jest.fn().mockReturnValue(userActor) };

    const { module, db: dbMock } = await createTestingModuleWithDb({
      providers: [
        SafeHttpService,
        { provide: SafeHttpPolicyEventsService, useValue: events },
        { provide: AuditContextService, useValue: audit },
      ],
    });

    service = module.get(SafeHttpService);
    db = dbMock;
  });

  describe('getPolicy', () => {
    it('returns the singleton row when exactly one exists', async () => {
      db.safeHttpPolicy.findMany.mockResolvedValue([buildRow()]);
      const result = await service.getPolicy();
      expect(result.id).toBe('policy-1');
    });

    it('throws NotFound when no row exists (pre-seed state)', async () => {
      db.safeHttpPolicy.findMany.mockResolvedValue([]);
      await expect(service.getPolicy()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws Conflict when multiple rows exist (schema state bug)', async () => {
      db.safeHttpPolicy.findMany.mockResolvedValue([buildRow({ id: 'a' }), buildRow({ id: 'b' })]);
      await expect(service.getPolicy()).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('updatePolicy', () => {
    const existing = buildRow();
    const validDto: UpdateSafeHttpPolicyDto = { defaultTimeoutMs: 15_000 };

    beforeEach(() => {
      db.safeHttpPolicy.findUnique.mockResolvedValue(existing);
      db.safeHttpPolicy.update.mockResolvedValue(
        buildRow({ ...existing, ...validDto, updatedAt: new Date(), updatedBy: 'user-1' }),
      );
    });

    it('persists the partial update and stamps updatedBy from the actor', async () => {
      const result = await service.updatePolicy('policy-1', validDto);

      expect(db.safeHttpPolicy.update).toHaveBeenCalledWith({
        where: { id: 'policy-1' },
        data: expect.objectContaining({ defaultTimeoutMs: 15_000, updatedBy: 'user-1' }),
      });
      expect(result.defaultTimeoutMs).toBe(15_000);
    });

    it('publishes the update event on success', async () => {
      await service.updatePolicy('policy-1', validDto);
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ updatedBy: 'user-1' }));
    });

    it('throws NotFound when the row does not exist', async () => {
      db.safeHttpPolicy.findUnique.mockResolvedValue(null);
      await expect(service.updatePolicy('missing', validDto)).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('strict-mode wildcard cross-validation', () => {
      it('rejects when DTO adds wildcards while existing strictMode is true', async () => {
        await expect(service.updatePolicy('policy-1', { allowedHosts: ['*.example.com'] })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });

      it('rejects when DTO flips strictMode on while existing has wildcards', async () => {
        db.safeHttpPolicy.findUnique.mockResolvedValue(
          buildRow({ strictMode: false, allowedHosts: ['*.example.com'] }),
        );

        await expect(service.updatePolicy('policy-1', { strictMode: true })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });

      it('rejects when DTO sets strictMode=true AND wildcards in the same payload', async () => {
        await expect(
          service.updatePolicy('policy-1', {
            strictMode: true,
            blockedHosts: ['*.evil.com'],
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('accepts wildcards when effective strictMode is false', async () => {
        await expect(
          service.updatePolicy('policy-1', {
            strictMode: false,
            allowedHosts: ['*.example.com'],
          }),
        ).resolves.toBeDefined();
      });

      it('accepts exact hostnames in strict mode', async () => {
        await expect(service.updatePolicy('policy-1', { allowedHosts: ['jenkins.local'] })).resolves.toBeDefined();
      });

      it('does not publish or persist when validation fails', async () => {
        await expect(service.updatePolicy('policy-1', { blockedHosts: ['*.evil.com'] })).rejects.toBeInstanceOf(
          BadRequestException,
        );

        expect(db.safeHttpPolicy.update).not.toHaveBeenCalled();
        expect(events.publish).not.toHaveBeenCalled();
      });
    });
  });
});
