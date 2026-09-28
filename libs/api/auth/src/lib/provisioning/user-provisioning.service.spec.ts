import { SystemRole } from '@bge/database';
import { PermissionsService } from '@bge/permissions';
import { ServiceAccountService } from '@bge/services';
import { createMockDatabaseService, createTestingModuleWithDb, makeUser, MockDatabaseService } from '@bge/testing';
import { UserProvisioningService } from './user-provisioning.service';

describe('UserProvisioningService', () => {
  let service: UserProvisioningService;
  let db: MockDatabaseService;

  let serviceAccount: Pick<ServiceAccountService, 'ensure' | 'resolve'>;
  let permissions: jest.Mocked<Pick<PermissionsService, 'invalidateUser'>>;

  beforeEach(async () => {
    const ctx = await createTestingModuleWithDb({
      providers: [
        UserProvisioningService,
        { provide: ServiceAccountService, useValue: { ensure: jest.fn(), resolve: jest.fn() } },
        { provide: PermissionsService, useValue: { invalidateUser: jest.fn() } },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(UserProvisioningService);
    serviceAccount = ctx.module.get(ServiceAccountService);
    permissions = ctx.module.get(PermissionsService);
  });

  afterEach(() => {
    jest.resetAllMocks();
    jest.clearAllMocks();
  });

  /** Every `$executeRaw` call, as its tagged template received it: the text with `?` per value, and the values. */
  const lockStatements = () =>
    db.$executeRaw.mock.calls.map(([strings, ...values]) => ({
      sql: (strings as readonly string[]).join('?'),
      values,
    }));

  it('gives the first human the base User role AND Owner, and seeds the service account', async () => {
    db.user.findUniqueOrThrow.mockResolvedValue(makeUser({ id: 'u1', username: 'a', email: 'a@x.io' }));
    // Nobody provisioned yet, both before the lock and under it.
    db.user.findFirst.mockResolvedValue(null);
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
    // The seat is taken once a human holds a global role (#430), not once a
    // second human row exists. Anonymous rows are not humans for the election
    // (#484): `isAnonymous` is nullable and a NULL is a human, so a bare
    // `isAnonymous: false` would silently stop counting those rows.
    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: { isServiceAccount: false, OR: [{ isAnonymous: false }, { isAnonymous: null }], roles: { some: {} } },
      select: { id: true },
    });
    expect(lockStatements()).toEqual([
      { sql: 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', values: ['bge:owner-election'] },
    ]);
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
    db.user.findFirst.mockResolvedValue({ id: 'u1' } as never);
    db.role.findMany.mockResolvedValue([{ id: 'role-user', name: SystemRole.User }] as never);
    db.$transaction.mockImplementation((cb) => cb(db));

    await service.provisionNewUser('u2');

    expect(db.userRole.createMany).toHaveBeenCalledWith({ data: [{ userId: 'u2', roleId: 'role-user' }] });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(serviceAccount.ensure).not.toHaveBeenCalled();

    // The seat was already taken before the transaction, so this signup never
    // queues on the election lock, and the look is not repeated.
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.user.findFirst).toHaveBeenCalledTimes(1);
  });

  it('writes the base role alone when another signup is elected while this one waits for the lock', async () => {
    db.user.findUniqueOrThrow.mockResolvedValue(makeUser({ id: 'u2', username: 'b', email: 'b@x.io' }));
    // Open at the unlocked look; taken by the time the lock is held, because
    // the other signup committed its roles while this one waited.
    db.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'u1' } as never);
    db.role.findMany.mockResolvedValue([
      { id: 'role-owner', name: SystemRole.Owner },
      { id: 'role-user', name: SystemRole.User },
    ] as never);
    db.$transaction.mockImplementation((cb) => cb(db));

    await service.provisionNewUser('u2');

    expect(db.userRole.createMany).toHaveBeenCalledWith({ data: [{ userId: 'u2', roleId: 'role-user' }] });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(serviceAccount.ensure).not.toHaveBeenCalled();
  });

  it('takes the election lock on the transaction and only then looks again', async () => {
    db.user.findUniqueOrThrow.mockResolvedValue(makeUser({ id: 'u1', username: 'a', email: 'a@x.io' }));
    db.user.findFirst.mockResolvedValue(null);
    db.role.findMany.mockResolvedValue([
      { id: 'role-owner', name: SystemRole.Owner },
      { id: 'role-user', name: SystemRole.User },
    ] as never);
    // A client of its own for the transaction, so a lock taken on the root
    // client cannot pass for one: that would be an autocommit statement,
    // released before the look it is meant to guard.
    const tx = createMockDatabaseService();
    tx.user.findFirst.mockResolvedValue(null);
    db.$transaction.mockImplementation((cb) => cb(tx));

    await service.provisionNewUser('u1');

    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    // One unlocked look outside, one under the lock inside.
    expect(db.user.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.user.findFirst).toHaveBeenCalledTimes(1);

    // A look taken before the lock proves nothing about the seat: the other
    // signup may be one statement away from committing its roles. So inside
    // the transaction the order is lock, look, write.
    const [lockTaken] = tx.$executeRaw.mock.invocationCallOrder;
    const [lookedUnderLock] = tx.user.findFirst.mock.invocationCallOrder;
    const [rolesWritten] = tx.userRole.createMany.mock.invocationCallOrder;

    expect(lockTaken).toBeLessThan(lookedUnderLock);
    expect(lookedUnderLock).toBeLessThan(rolesWritten);
  });

  it("evicts the user's permission graph once the roles have committed", async () => {
    db.user.findUniqueOrThrow.mockResolvedValue(makeUser({ id: 'u2', username: 'b', email: 'b@x.io' }));
    db.user.findFirst.mockResolvedValue({ id: 'u1' } as never);
    db.role.findMany.mockResolvedValue([{ id: 'role-user', name: SystemRole.User }] as never);

    const events: string[] = [];
    db.$transaction.mockImplementation(async (cb) => {
      const result = await cb(db);
      events.push('committed');
      return result;
    });
    permissions.invalidateUser.mockImplementation(async (userId) => {
      events.push(`evicted ${userId}`);
    });

    await service.provisionNewUser('u2');

    // After the transaction, not inside it: an eviction before the commit
    // could be followed by a read of the uncommitted, role-less state.
    expect(events).toEqual(['committed', 'evicted u2']);
  });

  it('gives an anonymous user AnonymousUser INSTEAD of User, and never treats it as the first human', async () => {
    db.user.findUniqueOrThrow.mockResolvedValue(
      makeUser({ id: 'anon-1', username: 'Anonymous', email: 'temp@anon-1.com', isAnonymous: true }),
    );
    // The worst case for the election: an install where nobody holds a role,
    // so an anonymous row that reached it would take the Owner seat.
    db.user.findFirst.mockResolvedValue(null);
    db.role.findMany.mockResolvedValue([{ id: 'role-anonymous', name: SystemRole.AnonymousUser }] as never);
    db.$transaction.mockImplementation((cb) => cb(db));

    await service.provisionNewUser('anon-1');

    // The exact set: `User` beside `AnonymousUser` would hand an anonymous
    // session everything a signed-in user can do (#484).
    expect(db.userRole.createMany).toHaveBeenCalledWith({ data: [{ userId: 'anon-1', roleId: 'role-anonymous' }] });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(serviceAccount.ensure).not.toHaveBeenCalled();

    // It never stands for election, so it neither looks at the seat nor
    // queues on the lock a first signup may be holding.
    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
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
    db.user.findFirst.mockResolvedValue(null);
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
