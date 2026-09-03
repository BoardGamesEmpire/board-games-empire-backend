import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * The seed properties that a multi-role actor's abilities depend on.
 *
 * Since #410 an actor can hold more than one GLOBAL role — the first human
 * holds `User` and `Owner` — and `AbilityFactory.createForUser` applies each
 * role's rules in the order `permissions.service.ts` reads them, which carries
 * no `ORDER BY`. That is only safe while every role-assigned rule is a `can`:
 * CASL is last-rule-wins, so a single inverted role permission would make an
 * actor's effective ability depend on which `user_roles` row Postgres happened
 * to return first — green in CI, denying in production after a row rewrite.
 *
 * The provisioning comment that grants two roles names this property as its
 * safety argument. This is where the property is actually held to.
 */
describe('role model invariants', () => {
  // Unused directly, but requiring it keeps this suite runnable only inside
  // the e2e harness (seeded DB), matching every sibling suite's contract.
  requireBaseUrl(process.env);

  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  it('assigns no inverted permission to any role, so role rule order cannot change an outcome', async () => {
    const inverted = await db.client.rolePermission.findMany({
      where: { permission: { inverted: true } },
      select: { role: { select: { name: true } }, permission: { select: { slug: true } } },
    });

    // Listed rather than counted: a failure should name the grant to move.
    // The fix is NOT to delete the assertion — an inverted role permission
    // needs a deterministic rule order first (an `orderBy` on the roles read,
    // or precedence held somewhere other than array position).
    expect(inverted.map((row) => `${row.role.name}:${row.permission.slug}`)).toEqual([]);
  });

  it('holds the base User grants that make Owner downlevelling meaningful', async () => {
    const user = await db.client.role.findUniqueOrThrow({
      where: { name: 'User' },
      select: { permissions: { select: { permission: { select: { slug: true } } } } },
    });
    const slugs = user.permissions.map((row) => row.permission.slug);

    // The three the issue cites as what an Owner-only actor would be missing.
    // If these ever leave `User`, the argument for additive elevation needs
    // restating rather than quietly weakening.
    expect(slugs).toEqual(expect.arrayContaining(['read:game', 'create:household', 'read:households']));
  });
});
