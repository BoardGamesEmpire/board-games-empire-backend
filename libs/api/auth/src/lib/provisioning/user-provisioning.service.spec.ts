import { ServiceAccountService } from '@bge/services';
import { createTestingModuleWithDb, MockDatabaseService } from '@bge/testing';
import { UserProvisioningService } from './user-provisioning.service';

describe('UserProvisioningService', () => {
  let service: UserProvisioningService;
  let db: MockDatabaseService;

  let serviceAccount: Pick<ServiceAccountService, 'ensure' | 'resolve'>;

  beforeEach(async () => {
    const ctx = await createTestingModuleWithDb({
      providers: [
        UserProvisioningService,
        { provide: ServiceAccountService, useValue: { ensure: jest.fn(), resolve: jest.fn() } },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(UserProvisioningService);
    serviceAccount = ctx.module.get(ServiceAccountService);
  });

  afterEach(() => {
    jest.resetAllMocks();
    jest.clearAllMocks();
  });

  it('makes the first human Owner (ignoring service accounts) and seeds the service account', async () => {
    db.user.count.mockResolvedValue(1);
    db.role.findUniqueOrThrow.mockResolvedValue({ id: 'role-owner' } as never);
    db.$transaction.mockImplementation((cb) => cb(db));

    await service.provisionNewUser({ id: 'u1', username: 'a', email: 'a@x.io' } as never);

    expect(db.user.count).toHaveBeenCalledWith({ where: { isServiceAccount: false } });
    expect(serviceAccount.ensure).toHaveBeenCalledTimes(1);
  });

  it('makes subsequent humans User and does not touch the service account', async () => {
    db.user.count.mockResolvedValue(2);
    db.role.findUniqueOrThrow.mockResolvedValue({ id: 'role-user' } as never);
    db.$transaction.mockImplementation((cb) => cb(db));

    await service.provisionNewUser({ id: 'u2', username: 'b', email: 'b@x.io' } as never);

    expect(serviceAccount.ensure).not.toHaveBeenCalled();
  });
});
