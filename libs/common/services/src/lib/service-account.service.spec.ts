import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { ServiceAccountService } from './service-account.service';

describe('ServiceAccountService', () => {
  let service: ServiceAccountService;
  let db: MockDatabaseService;

  beforeEach(async () => {
    const ctx = await createTestingModuleWithDb({ providers: [ServiceAccountService] });
    db = ctx.db;
    service = ctx.module.get(ServiceAccountService);
  });

  afterEach(() => {
    jest.resetAllMocks();
    jest.clearAllMocks();
  });

  it('upserts on the reserved username and re-asserts invariants on update', async () => {
    db.user.upsert.mockResolvedValue({ id: 'svc' } as never);
    await service.ensure();
    expect(db.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { username: '__system__' },
        update: { isServiceAccount: true, banned: true, emailVerified: true },
        create: expect.objectContaining({ isServiceAccount: true, banned: true, emailVerified: true }),
      }),
    );
  });

  it('resolves the canonical account by reserved username', async () => {
    db.user.findUniqueOrThrow.mockResolvedValue({ id: 'svc' } as never);
    await service.resolve();
    expect(db.user.findUniqueOrThrow).toHaveBeenCalledWith({
      where: {
        isServiceAccount: true,
        username: '__system__',
      },
    });
  });

  describe('resolveOrEnsure', () => {
    it('reads the existing account and writes nothing', async () => {
      db.user.findUnique.mockResolvedValue({ id: 'svc' } as never);

      await expect(service.resolveOrEnsure()).resolves.toEqual({ id: 'svc' });
      expect(db.user.findUnique).toHaveBeenCalledWith({
        where: { isServiceAccount: true, username: '__system__' },
      });
      expect(db.user.upsert).not.toHaveBeenCalled();
    });

    it('creates the account when it does not exist yet', async () => {
      db.user.findUnique.mockResolvedValue(null);
      db.user.upsert.mockResolvedValue({ id: 'svc' } as never);

      await expect(service.resolveOrEnsure()).resolves.toEqual({ id: 'svc' });
      expect(db.user.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { username: '__system__' } }));
    });
  });
});
