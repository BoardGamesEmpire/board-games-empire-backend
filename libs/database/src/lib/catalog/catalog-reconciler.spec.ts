import { Action, PermissionOwner, Prisma, ResourceType, RiskLevel, SystemRole, type PrismaClient } from '../client';
import { CATALOG_EDIT_LOCK_NAME } from './catalog-edit-lock';
import type { EntryProblem } from './catalog-entry-check';
import type { CatalogManifest, CatalogSnapshot, ReconcilePlan } from './catalog-reconcile-plan';
import { countMutations, edgeKey, planReconcile } from './catalog-reconcile-plan';
import {
  applyReconcilePlan,
  CATALOG_MANIFEST,
  CatalogReconcileShortWriteError,
  describeConflicts,
  describeDrift,
  describeWrites,
  findFailingEditedEntries,
  reconcileCatalog,
  summarizePlan,
} from './catalog-reconciler';
import type { PermissionSeedDefinition } from './seed-definitions';

// The apply's writes run only against Postgres (apps/api-e2e/src/database/
// catalog-reconcile.spec.ts). What is pure here is what the reconcile SAYS —
// the one-line summary, the drift report and the conflict sentences — and
// what it does with a statement's row count, over a transaction that lies.

const emptyPlan = (): ReconcilePlan => ({
  permissions: {
    create: [],
    update: [],
    revive: [],
    retire: [],
    retireEdited: [],
    skipped: [],
    retained: [],
    conflicts: [],
  },
  roles: { create: [], update: [], skipped: [], orphans: [], conflicts: [] },
  rolePermissions: {
    create: [],
    restore: [],
    delete: [],
    revokeEdited: [],
    withheld: [],
    skipped: [],
    retained: [],
    conflicts: [],
  },
});

const rejected: EntryProblem = {
  kind: 'query-rejected',
  slug: 'read:game',
  message: 'Unknown argument `visibility`. Available options are marked with ?.',
};
const readsPastReach: EntryProblem = {
  kind: 'reads-past-reach',
  slug: 'read:game',
  role: SystemRole.User,
  subject: ResourceType.Game,
  reads: 'fixed filter',
};
const failsOpen: EntryProblem = { kind: 'fails-open', slug: 'read:audit_log', role: SystemRole.HouseholdGuest };

/** A plan whose only writes retire one edited permission and revoke one edited grant (#772). */
const failingPlan = (): ReconcilePlan => ({
  ...emptyPlan(),
  permissions: {
    ...emptyPlan().permissions,
    retireEdited: [{ slug: 'read:game', problems: [rejected, readsPastReach] }],
  },
  rolePermissions: {
    ...emptyPlan().rolePermissions,
    revokeEdited: [{ roleName: SystemRole.HouseholdGuest, permissionSlug: 'read:audit_log', problems: [failsOpen] }],
  },
});

describe('what a reconcile says', () => {
  it('summarises the writes by table on one line', () => {
    const plan: ReconcilePlan = {
      ...emptyPlan(),
      permissions: {
        ...emptyPlan().permissions,
        create: [
          { action: Action.read, subject: ResourceType.Game, slug: 'read:game', riskLevel: RiskLevel.Low, reason: 'x' },
        ],
        revive: ['read:job'],
        retire: ['read:quota', 'read:media'],
      },
      rolePermissions: {
        ...emptyPlan().rolePermissions,
        delete: [{ roleName: SystemRole.User, permissionSlug: 'read:quota' }],
        restore: [{ roleName: SystemRole.User, permissionSlug: 'read:game' }],
      },
    };

    expect(summarizePlan(plan)).toBe(
      'Catalog reconcile: permissions +1 ~0 revived 1 retired 2; roles +0 ~0; grants +0 -1 restored 1; ' +
        'edits failing the entry check: retired 0, revoked 0; shipped grants withheld 0',
    );
  });

  it('counts the edited entries that fail their check on the summary line (#772)', () => {
    expect(summarizePlan(failingPlan())).toBe(
      'Catalog reconcile: permissions +0 ~0 revived 0 retired 0; roles +0 ~0; grants +0 -0 restored 0; ' +
        'edits failing the entry check: retired 1, revoked 1; shipped grants withheld 0',
    );
  });

  it('names each edited entry that fails its check and each kind of problem once, and keeps the detail for the write lines (#772)', () => {
    const plan = failingPlan();

    expect(describeDrift(plan)).toEqual([
      `Admin-owned permission 'read:game' fails the entry check (query-rejected, reads-past-reach): retired, the edit kept`,
      `Admin-owned grant 'HouseholdGuest → read:audit_log' fails the entry check (fails-open): revoked, the row kept`,
    ]);
    expect(describeWrites(plan)).toEqual([
      `permission 'read:game' retired after its check: query-rejected ` +
        '{"message":"Unknown argument `visibility`. Available options are marked with ?."}; ' +
        `reads-past-reach {"role":"User","subject":"Game","reads":"fixed filter"}`,
      `grant 'HouseholdGuest → read:audit_log' revoked after its check: fails-open {"role":"HouseholdGuest"}`,
    ]);

    // A kind two problems share is named once.
    const twice: ReconcilePlan = {
      ...emptyPlan(),
      permissions: {
        ...emptyPlan().permissions,
        retireEdited: [{ slug: 'read:game', problems: [readsPastReach, { ...readsPastReach, role: 'AnonymousUser' }] }],
      },
    };
    expect(describeDrift(twice)).toEqual([
      `Admin-owned permission 'read:game' fails the entry check (reads-past-reach): retired, the edit kept`,
    ]);
  });

  it('names every write that changes or removes authority, and leaves creates to the count', () => {
    const plan: ReconcilePlan = {
      ...emptyPlan(),
      permissions: {
        ...emptyPlan().permissions,
        create: [
          { action: Action.read, subject: ResourceType.Game, slug: 'read:game', riskLevel: RiskLevel.Low, reason: 'x' },
        ],
        update: [{ slug: 'read:job', changes: [{ field: 'riskLevel', from: RiskLevel.Low, to: RiskLevel.High }] }],
        revive: ['read:job'],
        retire: ['read:quota'],
      },
      roles: {
        ...emptyPlan().roles,
        create: [{ name: SystemRole.User, description: 'Standard user account' }],
        update: [{ name: SystemRole.Admin, changes: [{ field: 'description', from: 'Old', to: 'Full access' }] }],
      },
      rolePermissions: {
        ...emptyPlan().rolePermissions,
        create: [{ roleName: SystemRole.User, permissionSlug: 'read:game' }],
        delete: [{ roleName: SystemRole.Moderator, permissionSlug: 'read:quota' }],
        restore: [{ roleName: SystemRole.User, permissionSlug: 'read:game' }],
      },
    };

    expect(describeWrites(plan)).toEqual([
      `permission 'read:job' updated: riskLevel "Low" → "High"`,
      `permission 'read:job' revived`,
      `permission 'read:quota' retired`,
      `role 'Admin' updated: description "Old" → "Full access"`,
      `grant 'Moderator → read:quota' removed`,
      `grant 'User → read:game' restored`,
    ]);
  });

  it('reports every row it left alone, with its owner and its drift', () => {
    const plan: ReconcilePlan = {
      ...emptyPlan(),
      permissions: {
        ...emptyPlan().permissions,
        skipped: [
          {
            slug: 'read:game',
            managedBy: PermissionOwner.Admin,
            drift: [{ field: 'riskLevel', from: RiskLevel.Critical, to: RiskLevel.Low }],
          },
          { slug: 'read:job', managedBy: PermissionOwner.Admin, drift: [] },
        ],
        retained: [{ slug: 'read:quota', managedBy: PermissionOwner.Plugin, retiredAt: null }],
      },
      roles: { ...emptyPlan().roles, orphans: ['Librarian'] },
      rolePermissions: {
        ...emptyPlan().rolePermissions,
        delete: [{ roleName: 'Librarian', permissionSlug: 'read:quota' }],
        skipped: [{ roleName: 'User', permissionSlug: 'read:game' }],
        retained: [
          { roleName: 'Librarian', permissionSlug: 'read:game', managedBy: PermissionOwner.Admin, revokedAt: null },
        ],
      },
    };

    expect(describeDrift(plan)).toEqual([
      `Admin-owned permission 'read:game' left alone; drift: riskLevel "Critical" → "Low"`,
      `Admin-owned permission 'read:job' left alone; no drift`,
      `Plugin-owned permission 'read:quota' is not in the manifest; retained`,
      `System-owned role 'Librarian' is not in the manifest; the row is kept, 1 of its System grants is removed`,
      `grant 'User → read:game' was revoked on this server`,
      `Admin-owned grant 'Librarian → read:game' is not in the manifest; retained`,
    ]);
  });

  it("marks an Owner's entry that confers nothing as retired or revoked, at the start that fails it and every later one (#772)", () => {
    // Without the mark, a later start's drift line for an edit the entry
    // check failed reads the same as one for an edit that is live.
    const at = new Date('2026-11-08T00:00:00.000Z');
    const later: ReconcilePlan = {
      ...emptyPlan(),
      permissions: {
        ...emptyPlan().permissions,
        skipped: [
          {
            slug: 'read:game',
            managedBy: PermissionOwner.Admin,
            drift: [{ field: 'retiredAt', from: at, to: null }],
          },
        ],
        retained: [{ slug: 'read:quota', managedBy: PermissionOwner.Admin, retiredAt: at }],
      },
      rolePermissions: {
        ...emptyPlan().rolePermissions,
        retained: [
          { roleName: 'Librarian', permissionSlug: 'read:game', managedBy: PermissionOwner.Admin, revokedAt: at },
        ],
      },
    };

    expect(describeDrift(later)).toEqual([
      `Admin-owned permission 'read:game' (retired) left alone; drift: retiredAt "2026-11-08T00:00:00.000Z" → null`,
      `Admin-owned permission 'read:quota' (retired) is not in the manifest; retained`,
      `Admin-owned grant 'Librarian → read:game' (revoked) is not in the manifest; retained`,
    ]);

    // The start that fails them: the rows are still live in the snapshot.
    const failing = failingPlan();
    const first: ReconcilePlan = {
      ...failing,
      permissions: {
        ...failing.permissions,
        skipped: [{ slug: 'read:game', managedBy: PermissionOwner.Admin, drift: [] }],
      },
      rolePermissions: {
        ...failing.rolePermissions,
        retained: [
          {
            roleName: SystemRole.HouseholdGuest,
            permissionSlug: 'read:audit_log',
            managedBy: PermissionOwner.Admin,
            revokedAt: null,
          },
        ],
      },
    };

    expect(describeDrift(first)).toEqual([
      `Admin-owned permission 'read:game' fails the entry check (query-rejected, reads-past-reach): retired, the edit kept`,
      `Admin-owned permission 'read:game' (retired) left alone; no drift`,
      `Admin-owned grant 'HouseholdGuest → read:audit_log' fails the entry check (fails-open): revoked, the row kept`,
      `Admin-owned grant 'HouseholdGuest → read:audit_log' (revoked) is not in the manifest; retained`,
    ]);
  });

  it('names each conflict so the refusal says what to fix', () => {
    const plan: ReconcilePlan = {
      ...emptyPlan(),
      permissions: { ...emptyPlan().permissions, conflicts: [{ slug: 'read:game' }] },
      roles: { ...emptyPlan().roles, conflicts: [{ name: 'User' }] },
      rolePermissions: {
        ...emptyPlan().rolePermissions,
        conflicts: [{ roleName: 'User', permissionSlug: 'read:game' }],
      },
    };

    expect(describeConflicts(plan)).toEqual([
      `permission 'read:game' is Plugin-owned but the manifest defines it`,
      `role 'User' is Plugin-owned but the manifest defines it`,
      `grant 'User → read:game' is Plugin-owned but the manifest lists it`,
    ]);
    expect(describeConflicts(emptyPlan())).toEqual([]);
  });
});

describe('reconcileCatalog and the edits of the permission catalog (#772)', () => {
  // A start's reconcile writes the permission catalog as the Owner's edits do,
  // and the entry check on either side reads the whole of it. So the start
  // takes the edits' lock before it reads anything: an edit then either
  // commits before the start reads the tables and is judged by its check, or
  // waits for the start to commit and checks against what the start wrote.
  it("takes the permission catalog's edit lock as its transaction's first statement", async () => {
    const statements: string[] = [];
    const read = (statement: string) => async () => {
      statements.push(statement);
      return [];
    };
    const tx = {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        statements.push(`${strings.join('?')} ${JSON.stringify(values)}`);
        return 1;
      },
      permission: { findMany: read('permission.findMany') },
      role: { findMany: read('role.findMany') },
      rolePermission: { findMany: read('rolePermission.findMany') },
    };
    // Only `$transaction`: a statement outside the transaction would throw.
    const prisma = {
      $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
    } as unknown as PrismaClient;
    const nothingShipped: CatalogManifest = { permissions: [], roles: [], rolePermissions: {} };

    await reconcileCatalog(prisma, nothingShipped);

    expect(statements).toEqual([
      `SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) ${JSON.stringify([CATALOG_EDIT_LOCK_NAME])}`,
      'permission.findMany',
      'role.findMany',
      'rolePermission.findMany',
    ]);
  });
});

describe('applyReconcilePlan — a batch statement that writes fewer rows than planned', () => {
  // Under the boot lock (#236) the only way a `createMany`, `updateMany` or
  // `deleteMany` comes up short is a row another writer touched between the
  // snapshot and the write. The count is compared to the plan and the apply
  // throws, so the transaction rolls back and the log never names a write
  // that did not land.

  interface FakeTx {
    readonly calls: string[];
    readonly tx: Prisma.TransactionClient;
  }

  /**
   * Every batch statement reports the rows it was asked for, less `short` for
   * the one named. An `updateMany` guarded on `Admin` is the entry check's
   * (#772), and is named apart from the `System` one beside it.
   */
  function fakeTx(short: { readonly statement: string; readonly by: number } | undefined = undefined): FakeTx {
    const calls: string[] = [];
    const count = (statement: string, asked: number) => {
      calls.push(statement);
      return { count: short?.statement === statement ? asked - short.by : asked };
    };
    const ids = (rows: { slug?: string; name?: string }[]) => rows.map((row, i) => ({ ...row, id: `id-${i}` }));
    const checked = (statement: string, where: { managedBy: PermissionOwner }) =>
      where.managedBy === PermissionOwner.Admin ? `${statement} (entry check)` : statement;

    const tx = {
      permission: {
        createMany: async ({ data }: { data: unknown[] }) => count('permission.createMany', data.length),
        update: async () => void calls.push('permission.update'),
        updateMany: async ({ where }: { where: { slug: { in: string[] }; managedBy: PermissionOwner } }) =>
          count(checked('permission.updateMany', where), where.slug.in.length),
        findMany: async ({ where }: { where: { slug: { in: string[] } } }) =>
          ids(where.slug.in.map((slug) => ({ slug }))),
      },
      role: {
        createMany: async ({ data }: { data: unknown[] }) => count('role.createMany', data.length),
        update: async () => void calls.push('role.update'),
        findMany: async ({ where }: { where: { name: { in: string[] } } }) =>
          ids(where.name.in.map((name) => ({ name }))),
      },
      rolePermission: {
        deleteMany: async ({ where }: { where: { OR: unknown[] } }) =>
          count('rolePermission.deleteMany', where.OR.length),
        updateMany: async ({ where }: { where: { OR: unknown[]; managedBy: PermissionOwner } }) =>
          count(checked('rolePermission.updateMany', where), where.OR.length),
        createMany: async ({ data }: { data: unknown[] }) => count('rolePermission.createMany', data.length),
      },
    } as unknown as Prisma.TransactionClient;

    return { calls, tx };
  }

  const plan: ReconcilePlan = {
    ...emptyPlan(),
    permissions: {
      ...emptyPlan().permissions,
      create: [
        { action: Action.read, subject: ResourceType.Game, slug: 'read:game', riskLevel: RiskLevel.Low, reason: 'x' },
      ],
      retire: ['read:quota', 'read:media'],
      retireEdited: [{ slug: 'read:platform', problems: [{ ...rejected, slug: 'read:platform' }] }],
    },
    roles: { ...emptyPlan().roles, create: [{ name: SystemRole.User, description: 'Standard user account' }] },
    rolePermissions: {
      ...emptyPlan().rolePermissions,
      delete: [{ roleName: SystemRole.Moderator, permissionSlug: 'read:quota' }],
      restore: [{ roleName: SystemRole.Admin, permissionSlug: 'read:job' }],
      revokeEdited: [{ roleName: SystemRole.HouseholdGuest, permissionSlug: 'read:audit_log', problems: [failsOpen] }],
      create: [
        { roleName: SystemRole.User, permissionSlug: 'read:game' },
        { roleName: SystemRole.User, permissionSlug: 'read:media' },
      ],
    },
  };

  it('applies a plan whose every statement writes its planned count, in dependency order', async () => {
    const { calls, tx } = fakeTx();

    await applyReconcilePlan(tx, CATALOG_MANIFEST, plan);

    expect(calls).toEqual([
      'permission.createMany',
      'permission.updateMany',
      'permission.updateMany (entry check)',
      'role.createMany',
      'rolePermission.deleteMany',
      'rolePermission.updateMany',
      'rolePermission.updateMany (entry check)',
      'rolePermission.createMany',
    ]);
  });

  it("retires or revokes an edited entry only while it is the Owner's and not yet retired or revoked, and writes only the time (#772)", async () => {
    const permissionUpdates: unknown[] = [];
    const grantUpdates: unknown[] = [];
    const tx = {
      permission: {
        updateMany: async (args: unknown) => {
          permissionUpdates.push(args);
          return { count: 1 };
        },
        findMany: async () => [{ id: 'permission-1', slug: 'read:audit_log' }],
      },
      role: { findMany: async () => [{ id: 'role-1', name: SystemRole.HouseholdGuest }] },
      rolePermission: {
        updateMany: async (args: unknown) => {
          grantUpdates.push(args);
          return { count: 1 };
        },
      },
    } as unknown as Prisma.TransactionClient;

    await applyReconcilePlan(tx, CATALOG_MANIFEST, failingPlan());

    // `managedBy` is in the guard and never in the data: the edit stays the Owner's to fix and hand back.
    expect(permissionUpdates).toEqual([
      {
        where: { slug: { in: ['read:game'] }, managedBy: PermissionOwner.Admin, retiredAt: null },
        data: { retiredAt: expect.any(Date) },
      },
    ]);
    expect(grantUpdates).toEqual([
      {
        where: {
          managedBy: PermissionOwner.Admin,
          revokedAt: null,
          OR: [{ roleId: 'role-1', permissionId: 'permission-1' }],
        },
        data: { revokedAt: expect.any(Date) },
      },
    ]);
  });

  it('throws naming the statement and both counts when the grants land short, and runs nothing after it', async () => {
    const { calls, tx } = fakeTx({ statement: 'rolePermission.createMany', by: 1 });

    const apply = applyReconcilePlan(tx, CATALOG_MANIFEST, plan);

    await expect(apply).rejects.toThrow(CatalogReconcileShortWriteError);
    await expect(apply).rejects.toThrow(/rolePermission\.createMany wrote 1 of 2 planned row/);
    expect(calls.at(-1)).toBe('rolePermission.createMany');
  });

  it('checks the retire, remove and restore statements the same way, before anything that follows them', async () => {
    const retire = fakeTx({ statement: 'permission.updateMany', by: 2 });
    await expect(applyReconcilePlan(retire.tx, CATALOG_MANIFEST, plan)).rejects.toThrow(
      /permission\.updateMany wrote 0 of 2 planned row/,
    );
    expect(retire.calls).toEqual(['permission.createMany', 'permission.updateMany']);

    const remove = fakeTx({ statement: 'rolePermission.deleteMany', by: 1 });
    await expect(applyReconcilePlan(remove.tx, CATALOG_MANIFEST, plan)).rejects.toThrow(
      /rolePermission\.deleteMany wrote 0 of 1 planned row/,
    );
    expect(remove.calls).not.toContain('rolePermission.createMany');

    // A revoked grant someone handed back or removed under the plan is a short write too (#772).
    const restore = fakeTx({ statement: 'rolePermission.updateMany', by: 1 });
    await expect(applyReconcilePlan(restore.tx, CATALOG_MANIFEST, plan)).rejects.toThrow(
      /rolePermission\.updateMany wrote 0 of 1 planned row/,
    );
    expect(restore.calls).not.toContain('rolePermission.createMany');
  });

  it('checks the entry check’s retire and revoke the same way: an edit the Owner handed back under the plan is a short write (#772)', async () => {
    const retire = fakeTx({ statement: 'permission.updateMany (entry check)', by: 1 });
    await expect(applyReconcilePlan(retire.tx, CATALOG_MANIFEST, plan)).rejects.toThrow(
      /permission\.updateMany \(entry check\) wrote 0 of 1 planned row/,
    );
    expect(retire.calls).not.toContain('role.createMany');

    const revoke = fakeTx({ statement: 'rolePermission.updateMany (entry check)', by: 1 });
    await expect(applyReconcilePlan(revoke.tx, CATALOG_MANIFEST, plan)).rejects.toThrow(
      /rolePermission\.updateMany \(entry check\) wrote 0 of 1 planned row/,
    );
    expect(revoke.calls).not.toContain('rolePermission.createMany');
  });
});

describe('findFailingEditedEntries (#772)', () => {
  // The Owner's entries are judged at every start: Prisma's verdict on an
  // edited condition, and the catalog guards over the catalog as this start
  // leaves it against the catalog as the server ships it. Only what the
  // Owner's entries add is held against them.

  /** The tables as a converged start leaves them for `manifest`: every row the server's. */
  const convergedSnapshot = (manifest: CatalogManifest): CatalogSnapshot => ({
    permissions: manifest.permissions.map((wanted) => ({
      slug: wanted.slug,
      action: wanted.action,
      subject: wanted.subject,
      fields: [...(wanted.fields ?? [])],
      conditions: (wanted.conditions ?? {}) as Prisma.JsonObject,
      inverted: false,
      reason: wanted.reason,
      riskLevel: wanted.riskLevel,
      managedBy: PermissionOwner.System,
      retiredAt: null,
    })),
    roles: manifest.roles.map(({ name, description }) => ({ name, description, managedBy: PermissionOwner.System })),
    rolePermissions: Object.entries(manifest.rolePermissions).flatMap(([roleName, slugs]) =>
      slugs.map((permissionSlug) => ({
        roleName,
        permissionSlug,
        managedBy: PermissionOwner.System,
        revokedAt: null,
      })),
    ),
  });

  const shipped = convergedSnapshot(CATALOG_MANIFEST);

  /** `snapshot` with one permission made the Owner's, changed by `changes`. */
  const editPermission = (
    snapshot: CatalogSnapshot,
    slug: string,
    changes: Partial<CatalogSnapshot['permissions'][number]> = {},
  ): CatalogSnapshot => ({
    ...snapshot,
    permissions: snapshot.permissions.map((row) =>
      row.slug === slug ? { ...row, managedBy: PermissionOwner.Admin, ...changes } : row,
    ),
  });

  /** `snapshot` with one grant the Owner's: an existing one marked so, or a new one added. */
  const editGrant = (
    snapshot: CatalogSnapshot,
    roleName: string,
    permissionSlug: string,
    revokedAt: Date | null = null,
  ): CatalogSnapshot => ({
    ...snapshot,
    rolePermissions: [
      ...snapshot.rolePermissions.filter(
        (edge) => edge.roleName !== roleName || edge.permissionSlug !== permissionSlug,
      ),
      { roleName, permissionSlug, managedBy: PermissionOwner.Admin, revokedAt },
    ],
  });

  /**
   * An interactive transaction's client as the probe uses it: every model's
   * `count` answers 0, except that Prisma refuses a condition on a
   * `visibility` column, which no model has any more (#808).
   */
  const probeTx = () => {
    const statements: string[] = [];
    const count = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (JSON.stringify(where).includes('"visibility"')) {
        throw new Prisma.PrismaClientValidationError('\nUnknown argument `visibility`.', { clientVersion: 'test' });
      }
      return 0;
    });
    const executeRaw = async (statement: string) => {
      statements.push(statement);
      return 0;
    };
    const tx = new Proxy({} as Record<string | symbol, unknown>, {
      get: (_target, key) => (key === '$executeRawUnsafe' ? executeRaw : { count }),
    }) as unknown as Prisma.TransactionClient;

    return { count, statements, tx };
  };

  it('asks nothing of the database, and finds nothing, when the Owner has edited nothing', async () => {
    const untouchable = {} as Prisma.TransactionClient;

    const failing = await findFailingEditedEntries(untouchable, CATALOG_MANIFEST, shipped);

    expect(failing.permissions.size).toBe(0);
    expect(failing.grants.size).toBe(0);
  });

  it('fails an edited permission on Prisma’s verdict and on the guards, and passes one whose edit holds up', async () => {
    const { tx } = probeTx();
    const snapshot = editPermission(
      editPermission(shipped, 'read:game', { conditions: { visibility: 'Public' } }),
      'read:game_share:own',
      { riskLevel: RiskLevel.Critical },
    );

    const failing = await findFailingEditedEntries(tx, CATALOG_MANIFEST, snapshot);

    expect([...failing.permissions]).toEqual([
      [
        'read:game',
        [
          { kind: 'query-rejected', slug: 'read:game', message: 'Unknown argument `visibility`.' },
          {
            kind: 'reads-past-reach',
            slug: 'read:game',
            role: SystemRole.User,
            subject: ResourceType.Game,
            reads: 'fixed filter',
          },
        ],
      ],
    ]);
    expect(failing.grants.size).toBe(0);
  });

  it('fails an edited grant the guards refuse, and passes one that holds up', async () => {
    const { tx } = probeTx();
    const snapshot = editGrant(
      editGrant(shipped, SystemRole.HouseholdGuest, 'read:audit_log'),
      SystemRole.User,
      'read:game',
    );

    const failing = await findFailingEditedEntries(tx, CATALOG_MANIFEST, snapshot);

    expect(failing.permissions.size).toBe(0);
    expect([...failing.grants]).toEqual([
      [
        edgeKey(SystemRole.HouseholdGuest, 'read:audit_log'),
        [{ kind: 'fails-open', slug: 'read:audit_log', role: SystemRole.HouseholdGuest }],
      ],
    ]);
  });

  it('never judges an edited entry already retired or revoked, so a second start finds nothing new', async () => {
    const { count, tx } = probeTx();
    const retiredAt = new Date('2026-11-08T00:00:00Z');
    const snapshot = editGrant(
      editPermission(shipped, 'read:game', { conditions: { visibility: 'Public' }, retiredAt }),
      SystemRole.HouseholdGuest,
      'read:audit_log',
      retiredAt,
    );

    const failing = await findFailingEditedEntries(tx, CATALOG_MANIFEST, snapshot);

    expect(failing.permissions.size).toBe(0);
    expect(failing.grants.size).toBe(0);
    expect(count).not.toHaveBeenCalled();
  });

  it('retires an edited permission whose condition does not parse, rather than stopping the start', async () => {
    // `User` holds `read:game`, a read on a resource type with `reach`, so the
    // reach guard is handed the typo too. Had it thrown, the reconcile's
    // transaction would abort and every start would fail.
    const { tx } = probeTx();
    const snapshot = editPermission(shipped, 'read:game', { conditions: { createdById: '{{ user.id' } });

    const failing = await findFailingEditedEntries(tx, CATALOG_MANIFEST, snapshot);

    expect([...failing.permissions]).toEqual([
      ['read:game', [{ kind: 'template', slug: 'read:game', detail: expect.stringMatching(/^malformed-template: /) }]],
    ]);
    expect(planReconcile(CATALOG_MANIFEST, snapshot, failing).permissions.retireEdited).toEqual([
      { slug: 'read:game', problems: failing.permissions.get('read:game') },
    ]);
  });

  it('revokes in one start a grant that another grant revoked in that start had been exempting', async () => {
    // A newer version ships `read:game:fixture` with no condition and gives it
    // to no role; the Owner had given it to `User` and to `HouseholdMember`.
    // `User` holding it reads past reach. While `User` held it, the household
    // role holding it was exempt from fail-open; once `User`'s grant is
    // revoked it is not, and it must go in the same start, not the next.
    const fixture: PermissionSeedDefinition = {
      action: Action.read,
      subject: ResourceType.Game,
      slug: 'read:game:fixture',
      riskLevel: RiskLevel.Low,
      reason: 'fixture',
    };
    const manifest: CatalogManifest = { permissions: [fixture], roles: [], rolePermissions: {} };
    const owned = (revokedAt: Date | null) =>
      editGrant(
        editGrant(convergedSnapshot(manifest), SystemRole.User, fixture.slug, revokedAt),
        SystemRole.HouseholdMember,
        fixture.slug,
        revokedAt,
      );
    const { tx } = probeTx();

    const first = owned(null);
    const failing = await findFailingEditedEntries(tx, manifest, first);

    expect([...failing.grants]).toEqual([
      [
        edgeKey(SystemRole.User, fixture.slug),
        [
          {
            kind: 'reads-past-reach',
            slug: fixture.slug,
            role: SystemRole.User,
            subject: ResourceType.Game,
            reads: 'every row',
          },
        ],
      ],
      [
        edgeKey(SystemRole.HouseholdMember, fixture.slug),
        [{ kind: 'fails-open', slug: fixture.slug, role: SystemRole.HouseholdMember }],
      ],
    ]);
    expect(
      planReconcile(manifest, first, failing).rolePermissions.revokeEdited.map(({ roleName }) => roleName),
    ).toEqual([SystemRole.User, SystemRole.HouseholdMember]);

    // The next start finds both revoked, and writes nothing.
    const second = owned(new Date('2026-11-08T00:00:00Z'));
    const again = await findFailingEditedEntries(tx, manifest, second);

    expect(again.grants.size).toBe(0);
    expect(countMutations(planReconcile(manifest, second, again))).toBe(0);
  });

  it('does not judge a grant on a permission this start retires: the permission is the edit to fix', async () => {
    // `User` holding the edited `read:game` reads past reach. The grant is
    // judged as its permission, on every holder, so it would fail too; but
    // the retired permission confers nothing through it.
    const { tx } = probeTx();
    const snapshot = editGrant(
      editPermission(shipped, 'read:game', { conditions: { visibility: 'Public' } }),
      SystemRole.User,
      'read:game',
    );

    const failing = await findFailingEditedEntries(tx, CATALOG_MANIFEST, snapshot);

    expect([...failing.permissions.keys()]).toEqual(['read:game']);
    expect(failing.grants.size).toBe(0);
  });

  it('withholds a grant this start gives that the edited permission would fail open, and keeps the permission (#772)', async () => {
    // The server's next version gives `HouseholdMember` a household-scoped
    // permission the Owner had made unconditioned, and `User` holds it as
    // shipped. Judged against the grants in the database, it holds up, and
    // this same start would hand every household member the permission across
    // every household. Retiring the permission would take it from `User` too,
    // for a grant the Owner never made: the new grant is withheld instead.
    const scoped: PermissionSeedDefinition = {
      action: Action.read,
      subject: ResourceType.Household,
      slug: 'read:household:fixture',
      riskLevel: RiskLevel.Low,
      reason: 'fixture',
      conditions: { id: '{{ householdId }}' },
    };
    const shipsTheGrant: CatalogManifest = {
      permissions: [scoped],
      roles: [],
      rolePermissions: { [SystemRole.HouseholdMember]: [scoped.slug] },
    };
    const unconditioned = editPermission(convergedSnapshot({ ...shipsTheGrant, rolePermissions: {} }), scoped.slug, {
      conditions: {},
    });
    const { tx } = probeTx();

    const given = await findFailingEditedEntries(tx, shipsTheGrant, unconditioned);

    expect(given.permissions.size).toBe(0);
    expect([...given.withheld]).toEqual([
      [
        edgeKey(SystemRole.HouseholdMember, scoped.slug),
        [{ kind: 'fails-open', slug: scoped.slug, role: SystemRole.HouseholdMember }],
      ],
    ]);
    const plan = planReconcile(shipsTheGrant, unconditioned, given);
    expect(plan.rolePermissions.create).toEqual([]);
    expect(plan.rolePermissions.withheld).toEqual([
      {
        roleName: SystemRole.HouseholdMember,
        permissionSlug: scoped.slug,
        problems: given.withheld.get(edgeKey(SystemRole.HouseholdMember, scoped.slug)),
      },
    ]);
    expect(plan.permissions.retireEdited).toEqual([]);

    // The reverse: a grant this start removes is not held against the edit.
    const takesTheGrant: CatalogManifest = { ...shipsTheGrant, rolePermissions: {} };
    const holding = editPermission(convergedSnapshot(shipsTheGrant), scoped.slug, { conditions: {} });

    const taken = await findFailingEditedEntries(tx, takesTheGrant, holding);

    expect(taken.permissions.size).toBe(0);
    expect(taken.withheld.size).toBe(0);
  });

  it('withholds a shipped grant that a User grant the Owner revoked no longer exempts, and writes nothing for it again (#772)', async () => {
    // `User` holds an unconditioned permission as shipped, and the Owner
    // revoked that grant. A newer version also gives the permission to
    // `HouseholdMember`, which passes CI because `User` holding it exempts
    // every other holder. On this server `User` does not hold it, so the new
    // grant would reach every household's rows. The revoked grant confers
    // nothing, but it is the Owner's edit that makes the new one fail.
    const open: PermissionSeedDefinition = {
      action: Action.read,
      subject: ResourceType.Household,
      slug: 'read:household:fixture',
      riskLevel: RiskLevel.Low,
      reason: 'fixture',
    };
    const before: CatalogManifest = {
      permissions: [open],
      roles: [],
      rolePermissions: { [SystemRole.User]: [open.slug] },
    };
    const after: CatalogManifest = {
      ...before,
      rolePermissions: { [SystemRole.User]: [open.slug], [SystemRole.HouseholdMember]: [open.slug] },
    };
    const revoked = editGrant(convergedSnapshot(before), SystemRole.User, open.slug, new Date('2026-11-08T00:00:00Z'));
    const { count, tx } = probeTx();

    const failing = await findFailingEditedEntries(tx, after, revoked);

    expect([...failing.withheld]).toEqual([
      [
        edgeKey(SystemRole.HouseholdMember, open.slug),
        [{ kind: 'fails-open', slug: open.slug, role: SystemRole.HouseholdMember }],
      ],
    ]);
    expect(failing.permissions.size).toBe(0);
    expect(failing.grants.size).toBe(0);
    expect(count).not.toHaveBeenCalled();

    const plan = planReconcile(after, revoked, failing);
    expect(plan.rolePermissions.create).toEqual([]);
    expect(plan.rolePermissions.withheld.map(({ roleName }) => roleName)).toEqual([SystemRole.HouseholdMember]);
    expect(countMutations(plan)).toBe(0);
    expect(summarizePlan(plan)).toContain('shipped grants withheld 1');
    expect(describeDrift(plan)).toContain(
      `System grant '${SystemRole.HouseholdMember} → ${open.slug}' fails the entry check against the Owner's ` +
        `edits: not given, and judged again at the next start: fails-open {"role":"${SystemRole.HouseholdMember}"}`,
    );
  });

  it("withholds a revoked shipped grant this start would restore, when the Owner's edits make it fail (#772)", async () => {
    // A grant the server ships, revoked by the Owner and handed back, is
    // `System` and revoked: this start would restore it. It is judged the way
    // a created one is.
    const scoped: PermissionSeedDefinition = {
      action: Action.read,
      subject: ResourceType.Household,
      slug: 'read:household:fixture',
      riskLevel: RiskLevel.Low,
      reason: 'fixture',
      conditions: { id: '{{ householdId }}' },
    };
    const manifest: CatalogManifest = {
      permissions: [scoped],
      roles: [],
      rolePermissions: { [SystemRole.HouseholdMember]: [scoped.slug] },
    };
    const converged = editPermission(convergedSnapshot(manifest), scoped.slug, { conditions: {} });
    const handedBack: CatalogSnapshot = {
      ...converged,
      rolePermissions: converged.rolePermissions.map((edge) => ({
        ...edge,
        revokedAt: new Date('2026-11-08T00:00:00Z'),
      })),
    };
    const { tx } = probeTx();

    const failing = await findFailingEditedEntries(tx, manifest, handedBack);
    const plan = planReconcile(manifest, handedBack, failing);

    expect(failing.permissions.size).toBe(0);
    expect(plan.rolePermissions.restore).toEqual([]);
    expect(plan.rolePermissions.withheld.map(({ roleName }) => roleName)).toEqual([SystemRole.HouseholdMember]);
  });

  it('gives a shipped grant on a permission this start retires: the permission is the edit to fix (#772)', async () => {
    // The permission fails on its own, Prisma's verdict, so it confers nothing
    // through any grant; withholding the grant as well would leave a second
    // thing to hand back.
    const fixture: PermissionSeedDefinition = {
      action: Action.read,
      subject: ResourceType.Household,
      slug: 'read:household:fixture',
      riskLevel: RiskLevel.Low,
      reason: 'fixture',
      conditions: { id: '{{ householdId }}' },
    };
    const manifest: CatalogManifest = {
      permissions: [fixture],
      roles: [],
      rolePermissions: { [SystemRole.HouseholdMember]: [fixture.slug] },
    };
    const broken = editPermission(convergedSnapshot({ ...manifest, rolePermissions: {} }), fixture.slug, {
      conditions: { visibility: 'Public' },
    });
    const { tx } = probeTx();

    const failing = await findFailingEditedEntries(tx, manifest, broken);

    expect([...failing.permissions.keys()]).toEqual([fixture.slug]);
    expect(failing.withheld.size).toBe(0);
  });
});
