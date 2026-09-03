import { SystemRole } from '@bge/database';
import { ServiceAccountService } from '@bge/services';
import { createTestingModuleWithDb, makeUser, MockDatabaseService } from '@bge/testing';
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

  it('gives the first human the base User role AND Owner, and seeds the service account', async () => {
    db.user.findUniqueOrThrow.mockResolvedValue(makeUser({ id: 'u1', username: 'a', email: 'a@x.io' }));
    db.user.count.mockResolvedValue(1);
    // Two deliberate properties, both load-bearing. Distinct ids per role keep
    // the assertion below non-vacuous — a single shared id would pass even if
    // only one role were ever resolved. And the rows come back in the OPPOSITE
    // order to the role list, because `in` carries no ORDER BY: returning them
    // in `roleNames` order would let an implementation that maps the query
    // result straight through pass this test, which is exactly the heap-order
    // dependency the ordering is there to remove. Do not "tidy" this order.
    db.role.findMany.mockResolvedValue([
      { id: 'role-owner', name: SystemRole.Owner },
      { id: 'role-user', name: SystemRole.User },
    ] as never);
    db.$transaction.mockImplementation((cb) => cb(db));

    await service.provisionNewUser('u1');

    expect(db.user.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 'u1' } });
    expect(db.user.count).toHaveBeenCalledWith({ where: { isServiceAccount: false } });
    expect(db.userRole.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 'u1', roleId: 'role-user' },
        { userId: 'u1', roleId: 'role-owner' },
      ],
    });

    // The first-human side effects, asserted positively rather than only by
    // their absence for later humans. `emailVerified` and the better-auth
    // `role` column had no unit coverage at all before.
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { role: 'admin', emailVerified: true },
    });
    expect(serviceAccount.ensure).toHaveBeenCalledTimes(1);
  });

  it('gives everyone after the first human the base User role alone, and no service account', async () => {
    db.user.findUniqueOrThrow.mockResolvedValue(makeUser({ id: 'u2', username: 'b', email: 'b@x.io' }));
    db.user.count.mockResolvedValue(2);
    db.role.findMany.mockResolvedValue([{ id: 'role-user', name: SystemRole.User }] as never);
    db.$transaction.mockImplementation((cb) => cb(db));

    await service.provisionNewUser('u2');

    expect(db.userRole.createMany).toHaveBeenCalledWith({ data: [{ userId: 'u2', roleId: 'role-user' }] });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(serviceAccount.ensure).not.toHaveBeenCalled();
  });

  it('refuses a role set naming the same role twice rather than quietly deduplicating it', async () => {
    // Unreachable through `provisionNewUser`, whose role list is a literal, so
    // this reaches the seam directly in the repo's idiom for a private. The
    // caller that WILL pass a computed set is the promotion path (#422), and
    // the failure without this guard is an opaque P2002 from
    // `@@unique([userId, roleId])`, raised inside the transaction in a
    // detached provisioning handler where no client ever sees it.
    const seam = service as unknown as {
      resolveRoleAssignments(userId: string, roleNames: readonly SystemRole[]): Promise<unknown>;
    };

    await expect(seam.resolveRoleAssignments('u1', [SystemRole.User, SystemRole.User])).rejects.toThrow(
      /role\(s\) requested more than once: User/,
    );

    // Rejected before the catalog is queried: a malformed role set is the
    // caller's bug, not something to spend a round trip discovering.
    expect(db.role.findMany).not.toHaveBeenCalled();
  });

  it('refuses to provision against an unseeded catalog rather than granting a partial role set', async () => {
    db.user.findUniqueOrThrow.mockResolvedValue(makeUser({ id: 'u1', username: 'a', email: 'a@x.io' }));
    db.user.count.mockResolvedValue(1);
    // The catalog holds `User` but not `Owner` — the shape a half-run seed
    // leaves behind. `findMany` returns the short list without complaint,
    // which is what the replaced `findUniqueOrThrow` used to catch.
    db.role.findMany.mockResolvedValue([{ id: 'role-user', name: SystemRole.User }] as never);
    db.$transaction.mockImplementation((cb) => cb(db));

    await expect(service.provisionNewUser('u1')).rejects.toThrow(/role 'Owner' is missing from the catalog/);

    // Nothing was written, and no transaction was even opened: the catalog is
    // resolved before the transaction, so a half-seeded database costs one
    // read per signup rather than two inserts and a rollback.
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.userRole.createMany).not.toHaveBeenCalled();
    expect(db.userPreferences.create).not.toHaveBeenCalled();
    expect(db.userProfile.create).not.toHaveBeenCalled();
  });
});
