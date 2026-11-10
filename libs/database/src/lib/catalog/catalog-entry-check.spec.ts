import { Action, PermissionOwner, Prisma, ResourceType, RiskLevel, SystemRole } from '../client';
import type { CatalogView, EntryTarget } from './catalog-entry-check';
import {
  catalogViewFromManifest,
  catalogViewFromSnapshot,
  checkCatalogEntries,
  namedRoles,
  probeConditions,
} from './catalog-entry-check';
import type { CatalogSnapshot, PermissionSnapshotRow } from './catalog-reconcile-plan';
import { CATALOG_MANIFEST } from './catalog-reconciler';
import { PERMISSION_CATALOG } from './permission.catalog';
import { PAIRED_GRANTS, ROLE_PERMISSION_CATALOG } from './role-permission.catalog';
import type { PermissionSeedDefinition } from './seed-definitions';

const APPROVE = 'update:household_invite:approve';
const REVOKE = 'update:household_invite:revoke';
const REVOKE_AS_ADMIN = 'update:household_invite:revoke:as-admin';

const shipped = catalogViewFromManifest(CATALOG_MANIFEST);
const nothing: CatalogView = { permissions: [], rolePermissions: {} };

const shippedEntry = (slug: string): PermissionSeedDefinition => {
  const entry = PERMISSION_CATALOG.find((permission) => permission.slug === slug);
  if (entry === undefined) {
    throw new Error(`The permission catalog has no '${slug}'`);
  }
  return entry;
};

/** `view` with `role` holding one more grant. */
const withGrant = (view: CatalogView, role: string, slug: string): CatalogView => ({
  ...view,
  rolePermissions: { ...view.rolePermissions, [role]: [...(view.rolePermissions[role] ?? []), slug] },
});

/** `view` with one grant taken from `role`. */
const withoutGrant = (view: CatalogView, role: string, slug: string): CatalogView => ({
  ...view,
  rolePermissions: {
    ...view.rolePermissions,
    [role]: (view.rolePermissions[role] ?? []).filter((held) => held !== slug),
  },
});

/** `view` with one permission's conditions replaced. */
const withConditions = (view: CatalogView, slug: string, conditions: Prisma.InputJsonObject): CatalogView => ({
  ...view,
  permissions: view.permissions.map((entry) => (entry.slug === slug ? { ...entry, conditions } : entry)),
});

/** Every permission and every grant in `view`, as targets. */
const everyEntry = (view: CatalogView): EntryTarget[] => [
  ...view.permissions.map(({ slug }) => ({ slug })),
  ...Object.entries(view.rolePermissions).flatMap(([roleName, slugs]) => slugs.map((slug) => ({ roleName, slug }))),
];

describe('checkCatalogEntries', () => {
  it('finds no shipped role unpaired, so the paired-grant warning is only ever about an edit (#772)', () => {
    // Against an empty baseline every finding in the shipped catalog is new,
    // so this reads the shipped catalog's own pairing.
    const targets = [...new Set(PAIRED_GRANTS.flat())].map((slug) => ({ slug }));
    const { warnings } = checkCatalogEntries(nothing, shipped, targets);

    expect(warnings.filter(({ kind }) => kind === 'unpaired')).toEqual([]);

    // Not vacuous: each half of each pair is held by some shipped role.
    const held = new Set(Object.values(ROLE_PERMISSION_CATALOG).flat());
    expect(PAIRED_GRANTS.flat().filter((slug) => !held.has(slug))).toEqual([]);
  });

  it("refuses a variable the holding role's pass never supplies, judging every holder of an edited permission (#772)", () => {
    // Two holders, so the check has to name both: neither the base role's
    // pass nor a household role's renders an event.
    const baseline = withGrant(shipped, SystemRole.HouseholdMember, 'read:game');
    const after = withConditions(baseline, 'read:game', { deletedAt: null, createdById: '{{ eventId }}' });

    const { problems, warnings } = checkCatalogEntries(baseline, after, [{ slug: 'read:game' }]);

    expect(problems).toHaveLength(2);
    expect(problems).toEqual(
      expect.arrayContaining([
        { kind: 'cannot-render', slug: 'read:game', role: SystemRole.User, variables: ['eventId'] },
        { kind: 'cannot-render', slug: 'read:game', role: SystemRole.HouseholdMember, variables: ['eventId'] },
      ]),
    );
    expect(warnings).toEqual([]);
  });

  it('reports a condition that does not parse on a read every user or guest holds as a template problem, without throwing (#772)', () => {
    // The reach guard refuses to classify a template it cannot parse, and
    // throws. Handed one, it stopped the check, and with it every start,
    // before the template guard could report the typo.
    expect(
      checkCatalogEntries(shipped, withConditions(shipped, 'read:game', { createdById: '{{ user.id' }), [
        { slug: 'read:game' },
      ]),
    ).toEqual({
      problems: [{ kind: 'template', slug: 'read:game', detail: expect.stringMatching(/^malformed-template: /) }],
      warnings: [],
    });
    expect(
      checkCatalogEntries(shipped, withConditions(shipped, 'read:game:public', { reach: '{{> x }}' }), [
        { slug: 'read:game:public' },
      ]).problems,
    ).toEqual([{ kind: 'template', slug: 'read:game:public', detail: 'unsupported-token-type: >' }]);
  });

  it('refuses a fail-open grant on a household role, which would reach every household (#772)', () => {
    const baseline = withConditions(shipped, 'read:audit_log', {});
    const after = withGrant(baseline, SystemRole.HouseholdGuest, 'read:audit_log');

    expect(
      checkCatalogEntries(baseline, after, [{ roleName: SystemRole.HouseholdGuest, slug: 'read:audit_log' }]),
    ).toEqual({
      problems: [{ kind: 'fails-open', slug: 'read:audit_log', role: SystemRole.HouseholdGuest }],
      warnings: [],
    });
  });

  it('refuses update:household on HouseholdGuest because its conditions name other roles, so it would confer nothing (#772)', () => {
    const after = withGrant(shipped, SystemRole.HouseholdGuest, 'update:household');

    expect(
      checkCatalogEntries(shipped, after, [{ roleName: SystemRole.HouseholdGuest, slug: 'update:household' }]),
    ).toEqual({
      problems: [
        {
          kind: 'names-other-roles',
          slug: 'update:household',
          role: SystemRole.HouseholdGuest,
          named: [SystemRole.HouseholdOwner, SystemRole.HouseholdAdmin],
        },
      ],
      warnings: [],
    });
  });

  it('warns, without refusing, when a role keeps approve but loses revoke:as-admin (#772)', () => {
    // The warning is keyed on the slug the role still holds, and the revoked
    // grant is the target: matching it through `partners` is what keeps the
    // warning from being filtered away.
    const after = withoutGrant(shipped, SystemRole.HouseholdAdmin, REVOKE_AS_ADMIN);

    expect(
      checkCatalogEntries(shipped, after, [{ roleName: SystemRole.HouseholdAdmin, slug: REVOKE_AS_ADMIN }]),
    ).toEqual({
      problems: [],
      warnings: [
        { kind: 'unpaired', slug: APPROVE, role: SystemRole.HouseholdAdmin, partners: [REVOKE, REVOKE_AS_ADMIN] },
      ],
    });
  });

  it('warns when a role keeps a revoke but loses approve, the other half of the pair (#772)', () => {
    const after = withoutGrant(shipped, SystemRole.HouseholdOwner, APPROVE);

    expect(checkCatalogEntries(shipped, after, [{ roleName: SystemRole.HouseholdOwner, slug: APPROVE }])).toEqual({
      problems: [],
      warnings: [{ kind: 'unpaired', slug: REVOKE, role: SystemRole.HouseholdOwner, partners: [APPROVE] }],
    });
  });

  it('warns, without refusing, when the base role gains an unconditioned grant, which reaches every user (#772)', () => {
    // The unconditioned-grant guards exempt every slug `User` holds, so
    // without its own report the broadest such grant there is said nothing.
    const after = withGrant(shipped, SystemRole.User, 'delete:game');

    expect(checkCatalogEntries(shipped, after, [{ roleName: SystemRole.User, slug: 'delete:game' }])).toEqual({
      problems: [],
      warnings: [{ kind: 'unconditioned-global', slug: 'delete:game', role: SystemRole.User }],
    });
  });

  it('refuses a read on every resource type given to the base role, which reads past every row’s reach (#772)', () => {
    // A grant on `all` reaches every resource type, those whose rows carry a
    // `reach` among them, so the reach guard judges it as one of them.
    for (const slug of ['read:public_content', 'manage:all']) {
      expect(
        checkCatalogEntries(shipped, withGrant(shipped, SystemRole.User, slug), [{ roleName: SystemRole.User, slug }]),
      ).toEqual({
        problems: [{ kind: 'reads-past-reach', slug, role: SystemRole.User, subject: 'all', reads: 'every row' }],
        warnings: [{ kind: 'unconditioned-global', slug, role: SystemRole.User }],
      });
    }
  });

  it("refuses a read the base role holds that stops binding the caller and ignores its rows' reach (#772)", () => {
    // `read:game` is a user's own games. Unconditioned, it hands every private
    // game to every user; `{ deletedAt: null }` hands every live one.
    expect(checkCatalogEntries(shipped, withConditions(shipped, 'read:game', {}), [{ slug: 'read:game' }])).toEqual({
      problems: [
        {
          kind: 'reads-past-reach',
          slug: 'read:game',
          role: SystemRole.User,
          subject: ResourceType.Game,
          reads: 'every row',
        },
      ],
      warnings: [{ kind: 'unconditioned-global', slug: 'read:game', role: SystemRole.User }],
    });
    expect(
      checkCatalogEntries(shipped, withConditions(shipped, 'read:game', { deletedAt: null }), [{ slug: 'read:game' }])
        .problems,
    ).toEqual([
      {
        kind: 'reads-past-reach',
        slug: 'read:game',
        role: SystemRole.User,
        subject: ResourceType.Game,
        reads: 'fixed filter',
      },
    ]);
  });

  it("judges a grant on the base role as its permission, since that grant decides other holders' exemption (#772)", () => {
    // `User` holding an unconditioned `read:platform` excuses any scoped role
    // holding it too, so giving it to a household role says nothing. Taking
    // it from `User` turns that grant fail-open, on a role the target doesn't
    // name.
    const scoped = withGrant(shipped, SystemRole.HouseholdGuest, 'read:platform');
    expect(
      checkCatalogEntries(shipped, scoped, [{ roleName: SystemRole.HouseholdGuest, slug: 'read:platform' }]),
    ).toEqual({ problems: [], warnings: [] });

    const after = withoutGrant(scoped, SystemRole.User, 'read:platform');

    expect(checkCatalogEntries(scoped, after, [{ roleName: SystemRole.User, slug: 'read:platform' }])).toEqual({
      problems: [{ kind: 'fails-open', slug: 'read:platform', role: SystemRole.HouseholdGuest }],
      warnings: [],
    });
  });

  it('reports nothing the baseline already had, so a shipped finding never blocks an edit (#772)', () => {
    const targets = everyEntry(shipped);

    expect(checkCatalogEntries(shipped, shipped, targets)).toEqual({ problems: [], warnings: [] });

    // Not vacuous: the shipped catalog has findings of its own, such as the
    // declared unconditioned staff grants, and the diff is what drops them.
    expect(checkCatalogEntries(nothing, shipped, targets).warnings).not.toEqual([]);
  });

  it("reports only the targets' findings, keying a grant target on its role (#772)", () => {
    const after = withGrant(
      withGrant(shipped, SystemRole.HouseholdGuest, 'update:household'),
      SystemRole.EventGuest,
      'read:audit_log',
    );

    expect(
      checkCatalogEntries(shipped, after, [{ roleName: SystemRole.HouseholdMember, slug: 'update:household' }]),
    ).toEqual({
      problems: [],
      warnings: [],
    });
    expect(checkCatalogEntries(shipped, after, [{ slug: 'read:audit_log' }]).problems).toEqual([
      { kind: 'fails-open', slug: 'read:audit_log', role: SystemRole.EventGuest },
    ]);
  });

  it('compares findings whatever order a condition comes back from the database in (#772)', () => {
    // Postgres stores conditions as `jsonb`, which reorders an object's keys,
    // so a snapshot's condition can list its variables in another order than
    // the permission catalog's. That is the same finding, not a new one.
    const fixture: PermissionSeedDefinition = {
      action: Action.read,
      subject: ResourceType.Game,
      slug: 'read:game:fixture',
      riskLevel: RiskLevel.Low,
      reason: 'fixture',
      conditions: { createdById: '{{ householdId }}', id: '{{ eventId }}' },
    };
    const baseline: CatalogView = { permissions: [fixture], rolePermissions: { [SystemRole.User]: [fixture.slug] } };
    const after = withConditions(baseline, fixture.slug, { id: '{{ eventId }}', createdById: '{{ householdId }}' });

    expect(checkCatalogEntries(nothing, baseline, [{ slug: fixture.slug }]).problems).toEqual([
      { kind: 'cannot-render', slug: fixture.slug, role: SystemRole.User, variables: ['householdId', 'eventId'] },
    ]);
    expect(checkCatalogEntries(baseline, after, [{ slug: fixture.slug }])).toEqual({ problems: [], warnings: [] });
  });
});

describe('namedRoles', () => {
  it('reads equals and in forms under a role relation (#772)', () => {
    expect(namedRoles(shippedEntry('update:household').conditions)).toEqual([
      SystemRole.HouseholdOwner,
      SystemRole.HouseholdAdmin,
    ]);
    expect(namedRoles(shippedEntry('delete:household').conditions)).toEqual([SystemRole.HouseholdOwner]);
    expect(namedRoles({ role: { is: { name: { equals: SystemRole.HouseholdGuest } } } })).toEqual([
      SystemRole.HouseholdGuest,
    ]);
    expect(namedRoles({ reach: 'Public' })).toEqual([]);
  });

  it('reads no name outside a role relation, and no value that is not a role (#772)', () => {
    expect(namedRoles({ name: SystemRole.HouseholdOwner })).toEqual([]);
    expect(namedRoles({ role: { is: { name: 'Board game club' } } })).toEqual([]);
    expect(namedRoles(undefined)).toEqual([]);
  });
});

describe('catalog views', () => {
  const row = (
    overrides: Partial<PermissionSnapshotRow> & Pick<PermissionSnapshotRow, 'slug'>,
  ): PermissionSnapshotRow => ({
    action: Action.read,
    subject: ResourceType.Game,
    fields: [],
    conditions: null,
    inverted: false,
    reason: 'fixture',
    riskLevel: RiskLevel.Low,
    managedBy: PermissionOwner.System,
    retiredAt: null,
    ...overrides,
  });

  it('reads the permission catalog as it ships (#772)', () => {
    expect(catalogViewFromManifest(CATALOG_MANIFEST)).toEqual({
      permissions: PERMISSION_CATALOG,
      rolePermissions: ROLE_PERMISSION_CATALOG,
    });
  });

  it('leaves out retired permissions, revoked grants, and grants on a permission it leaves out, as the loaders do (#772)', () => {
    const grant = (roleName: string, permissionSlug: string, revokedAt: Date | null = null) => ({
      roleName,
      permissionSlug,
      managedBy: PermissionOwner.System,
      revokedAt,
    });
    const snapshot: CatalogSnapshot = {
      permissions: [
        row({ slug: 'read:game', conditions: { createdById: '{{ user.id }}' }, fields: ['name'] }),
        row({ slug: 'read:game:public', retiredAt: new Date('2026-11-01T00:00:00.000Z') }),
      ],
      roles: [],
      rolePermissions: [
        grant(SystemRole.User, 'read:game'),
        grant(SystemRole.AnonymousUser, 'read:game', new Date('2026-11-01T00:00:00.000Z')),
        grant(SystemRole.AnonymousUser, 'read:game:public'),
        grant(SystemRole.HouseholdGuest, 'read:game:absent'),
      ],
    };

    expect(catalogViewFromSnapshot(snapshot)).toEqual({
      permissions: [
        {
          action: Action.read,
          subject: ResourceType.Game,
          slug: 'read:game',
          riskLevel: RiskLevel.Low,
          reason: 'fixture',
          conditions: { createdById: '{{ user.id }}' },
          fields: ['name'],
        },
      ],
      rolePermissions: { [SystemRole.User]: ['read:game'] },
    });
  });

  it('leaves out the grants of a role the scope map does not classify, so the check can judge the rest (#772)', () => {
    // A role a newer version dropped, or a custom role (#1170), has no known
    // render pass, and the guards refuse to judge such a role at all.
    const snapshot: CatalogSnapshot = {
      permissions: [row({ slug: 'read:game', conditions: { createdById: '{{ user.id }}' } })],
      roles: [],
      rolePermissions: [
        { roleName: SystemRole.User, permissionSlug: 'read:game', managedBy: PermissionOwner.System, revokedAt: null },
        { roleName: 'Board game club', permissionSlug: 'read:game', managedBy: PermissionOwner.Admin, revokedAt: null },
        { roleName: 'constructor', permissionSlug: 'read:game', managedBy: PermissionOwner.Admin, revokedAt: null },
      ],
    };
    const view = catalogViewFromSnapshot(snapshot);

    expect(view.rolePermissions).toEqual({ [SystemRole.User]: ['read:game'] });
    expect(checkCatalogEntries(view, view, everyEntry(view))).toEqual({ problems: [], warnings: [] });
  });
});

describe('probeConditions without a query', () => {
  const untouched = () => {
    const client = { $executeRawUnsafe: jest.fn() };
    return { client, tx: client as unknown as Prisma.TransactionClient };
  };

  it('passes an absent or empty condition without asking the database (#772)', async () => {
    const { client, tx } = untouched();

    await expect(probeConditions(tx, { slug: 'read:game', subject: ResourceType.Game })).resolves.toEqual([]);
    await expect(
      probeConditions(tx, { slug: 'read:game', subject: ResourceType.Game, conditions: {} }),
    ).resolves.toEqual([]);
    expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('leaves a condition that does not parse to the template guard, which reports it (#772)', async () => {
    const { client, tx } = untouched();

    await expect(
      probeConditions(tx, { slug: 'read:game', subject: ResourceType.Game, conditions: { createdById: '{{ user.id' } }),
    ).resolves.toEqual([]);
    expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('refuses a condition that renders to something that is not JSON, without a query (#772)', async () => {
    // Every guard passes this: it parses, and names only `role`. Rendered
    // with a role, the inverted section drops the text between, and what is
    // left does not parse as JSON.
    const { client, tx } = untouched();

    await expect(
      probeConditions(tx, {
        slug: 'read:game',
        subject: ResourceType.Game,
        conditions: { a: '{{^role}}', 'b{{/role}}': 1 },
      }),
    ).resolves.toEqual([{ kind: 'template', slug: 'read:game', detail: expect.stringMatching(/^render-failed: /) }]);
    expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('refuses a condition on a resource type with no model, which no query can judge (#772)', async () => {
    const { client, tx } = untouched();

    await expect(
      probeConditions(tx, { slug: 'read:public_content', subject: 'all', conditions: { id: 'x' } }),
    ).resolves.toEqual([{ kind: 'subject-has-no-model', slug: 'read:public_content', subject: 'all' }]);
    await expect(
      probeConditions(tx, {
        slug: 'read:data_gateway:search',
        subject: ResourceType.DataGatewaySearch,
        conditions: { id: 'x' },
      }),
    ).resolves.toEqual([
      { kind: 'subject-has-no-model', slug: 'read:data_gateway:search', subject: ResourceType.DataGatewaySearch },
    ]);
    expect(client.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('probeConditions around its query', () => {
  const recording = (count: jest.Mock) => {
    const statements: string[] = [];
    const client = {
      $executeRawUnsafe: jest.fn(async (statement: string) => {
        statements.push(statement);
        return 0;
      }),
      game: { count },
    };
    return { statements, tx: client as unknown as Prisma.TransactionClient };
  };

  it('renders every placeholder to a sample value, queries inside a savepoint, and releases it (#772)', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const { statements, tx } = recording(count);

    await expect(
      probeConditions(tx, {
        slug: 'read:game:fixture',
        subject: ResourceType.Game,
        conditions: {
          createdById: '{{ user.id }}',
          title: '{{ role }}',
          id: { in: ['{{ householdId }}', '{{ eventId }}', '{{ plugin.id }}', '{{ unit.userId }}'] },
          description: '{{ unit.scopeType }}',
        },
      }),
    ).resolves.toEqual([]);

    const sample = 'c0probe0000000000000000000';
    expect(count).toHaveBeenCalledWith({
      where: {
        AND: [
          { id: sample },
          {
            createdById: sample,
            title: SystemRole.User,
            id: { in: [sample, sample, sample, sample] },
            description: 'Household',
          },
        ],
      },
    });
    expect(statements).toEqual(['SAVEPOINT catalog_entry_probe', 'RELEASE SAVEPOINT catalog_entry_probe']);
  });

  it('reads at most one row: a primary key lookup ANDed in, or the first match on a model with no id (#772)', async () => {
    // The probe runs at every start for each permission the Owner edited, so
    // a condition no index covers must not scan the table to be judged.
    const count = jest.fn().mockResolvedValue(0);
    const client = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      householdSettings: { count },
    } as unknown as Prisma.TransactionClient;

    await expect(
      probeConditions(client, {
        slug: 'read:household_settings:fixture',
        subject: 'HouseholdSettings' as ResourceType,
        conditions: { householdId: '{{ householdId }}' },
      }),
    ).resolves.toEqual([]);

    expect(count).toHaveBeenCalledWith({ where: { householdId: 'c0probe0000000000000000000' }, take: 1 });
  });

  it("returns Prisma's verdict as one problem, its reason line, and rolls back to the savepoint (#772)", async () => {
    const message =
      '\nInvalid `tx.game.count()` invocation:\n\n{ where: { visibility: "Public" } }\n\nUnknown argument `visibility`.';
    const count = jest
      .fn()
      .mockRejectedValue(new Prisma.PrismaClientValidationError(message, { clientVersion: 'test' }));
    const { statements, tx } = recording(count);

    await expect(
      probeConditions(tx, { slug: 'read:game', subject: ResourceType.Game, conditions: { visibility: 'Public' } }),
    ).resolves.toEqual([{ kind: 'query-rejected', slug: 'read:game', message: 'Unknown argument `visibility`.' }]);
    expect(statements).toEqual(['SAVEPOINT catalog_entry_probe', 'ROLLBACK TO SAVEPOINT catalog_entry_probe']);
  });

  it("rethrows an error that is not Prisma's verdict on the condition, after rolling back to the savepoint (#772)", async () => {
    const lost = new Error('connection lost');
    const { statements, tx } = recording(jest.fn().mockRejectedValue(lost));

    await expect(
      probeConditions(tx, { slug: 'read:game', subject: ResourceType.Game, conditions: { deletedAt: null } }),
    ).rejects.toBe(lost);
    expect(statements).toEqual(['SAVEPOINT catalog_entry_probe', 'ROLLBACK TO SAVEPOINT catalog_entry_probe']);
  });

  /** A driver adapter's error as the pg adapter throws it, Prisma class or none. */
  const driverAdapterError = (sqlState: string, message: string) =>
    Object.assign(new Error(message), {
      name: 'DriverAdapterError',
      cause: { originalCode: sqlState, originalMessage: message, kind: 'postgres', code: sqlState, message },
    });

  it('refuses a value Postgres rejects as data even when Prisma does not wrap the error (#772)', async () => {
    // A NUL byte in a string arrives as a bare driver adapter error, SQLSTATE
    // 22021: class 22, a data exception, is about the condition's values.
    const nul = driverAdapterError('22021', 'invalid byte sequence for encoding "UTF8": 0x00');
    const { statements, tx } = recording(jest.fn().mockRejectedValue(nul));

    await expect(
      probeConditions(tx, { slug: 'read:game', subject: ResourceType.Game, conditions: { title: 'a\u0000b' } }),
    ).resolves.toEqual([
      { kind: 'query-rejected', slug: 'read:game', message: 'invalid byte sequence for encoding "UTF8": 0x00' },
    ]);
    expect(statements).toEqual(['SAVEPOINT catalog_entry_probe', 'ROLLBACK TO SAVEPOINT catalog_entry_probe']);
  });

  it.each([
    ['P1017', 'the server closed the connection'],
    ['P2024', 'the connection pool timed out'],
    ['P2028', 'the transaction closed or timed out'],
    ['P2034', 'a write conflict'],
  ])('rethrows a known request error %s, %s, which is about the database, not the condition (#772)', async (code) => {
    const failed = new Prisma.PrismaClientKnownRequestError('Transaction already closed', {
      code,
      clientVersion: 'test',
    });
    const { tx } = recording(jest.fn().mockRejectedValue(failed));

    await expect(
      probeConditions(tx, { slug: 'read:game', subject: ResourceType.Game, conditions: { deletedAt: null } }),
    ).rejects.toBe(failed);
  });

  it('refuses on a known request error about the query, such as a value out of range (#772)', async () => {
    const outOfRange = new Prisma.PrismaClientKnownRequestError('Value out of range for the type: integer', {
      code: 'P2020',
      clientVersion: 'test',
    });
    const { tx } = recording(jest.fn().mockRejectedValue(outOfRange));

    await expect(
      probeConditions(tx, { slug: 'read:game', subject: ResourceType.Game, conditions: { deletedAt: null } }),
    ).resolves.toEqual([
      { kind: 'query-rejected', slug: 'read:game', message: 'Value out of range for the type: integer' },
    ]);
  });

  it('rethrows a driver adapter error outside class 22, which is about the database, not the condition (#772)', async () => {
    const broken = driverAdapterError('08006', 'connection failure');
    const { tx } = recording(jest.fn().mockRejectedValue(broken));

    await expect(
      probeConditions(tx, { slug: 'read:game', subject: ResourceType.Game, conditions: { deletedAt: null } }),
    ).rejects.toBe(broken);
  });
});
