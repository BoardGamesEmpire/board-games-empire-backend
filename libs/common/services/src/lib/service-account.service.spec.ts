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
});
