import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * What the settings PATCH accepts (#571) and what both settings routes return
 * (#572).
 *
 * Every setting can be changed through the PATCH, within the bounds its reader
 * can act on. Anything else answers 400 or 404, never a 500 from the database.
 * The database holds the day counts to the same bounds, so a write that skips
 * the PATCH is refused too. Neither route publishes the signing secret or the
 * row bookkeeping. The e2e row's `mediaSigningSecret` is null, because no seed
 * sets it, so the tests assert the keys are absent rather than checking a
 * value.
 *
 * Implicit conversion runs before validation, so some wrong types are not
 * refused here (#623). A string sent for a boolean becomes `true`, and `true`
 * sent for a day count that is not nullable becomes 1. `null` is the one value
 * a boolean property can refuse.
 *
 * The settings row is on the isolation sweep's preserved list, so a write here
 * would outlive the test. Each test restores every column the PATCH can write.
 */
describe('system settings update', () => {
  const baseUrl = requireBaseUrl(process.env);
  const SETTINGS_PATH = '/api/system-settings';

  const WRITABLE = {
    name: true,
    allowPasswordResets: true,
    allowUserRegistration: true,
    allowUsernameChange: true,
    feedbackReportRetentionDays: true,
    feedbackReportServerRedactionEnabled: true,
    requireContributionApproval: true,
    contributionReclaimDays: true,
    auditLogRetentionDays: true,
    reviewGatewayLanguages: true,
  } as const;

  const NOT_NULLABLE = Object.keys(WRITABLE).filter((key) => key !== 'auditLogRetentionDays');
  const DAY_COUNTS = ['feedbackReportRetentionDays', 'contributionReclaimDays', 'auditLogRetentionDays'];
  const MAX_DAYS = 36_500;
  const MAX_NAME_LENGTH = 100;

  /** `a`, unless the row already holds it, so the write always changes the value. */
  const differentFrom = <T>(current: T, a: T, b: T) => (current === a ? b : a);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const readSettings = () =>
    db.client.systemSetting.findUniqueOrThrow({
      where: { singleton: true },
      select: { id: true, ...WRITABLE },
    });

  let original: Awaited<ReturnType<typeof readSettings>>;

  beforeEach(async () => {
    original = await readSettings();
  });

  afterEach(async () => {
    const { id, ...settings } = original;
    await db.client.systemSetting.update({ where: { id }, data: settings });
  });

  const patch = (actor: SessionActor, body: object, id = original.id) =>
    request(baseUrl).patch(`${SETTINGS_PATH}/${id}`).set(actor.headers).send(body);

  const expectReadShape = (settings: Record<string, unknown>) => {
    expect(Object.keys(settings).sort()).toEqual(['id', ...Object.keys(WRITABLE)].sort());
    for (const withheld of ['mediaSigningSecret', 'identifier', 'singleton']) {
      expect(settings).not.toHaveProperty(withheld);
    }
  };

  describe('read shape', () => {
    it('serves the settings without the signing secret or the row bookkeeping, to every staff reader', async () => {
      const [admin, moderator] = await Promise.all([actors.admin(), actors.moderator()]);

      for (const reader of [admin, moderator]) {
        const { body } = await request(baseUrl).get(SETTINGS_PATH).set(reader.headers).expect(200);

        expectReadShape(body.settings);
      }
    });

    it('answers a PATCH with the same shape', async () => {
      const admin = await actors.admin();

      const { body } = await patch(admin, { allowUsernameChange: !original.allowUsernameChange }).expect(200);

      expectReadShape(body.settings);
    });
  });

  describe('writes', () => {
    it('sets every setting, and reads the change back', async () => {
      const admin = await actors.admin();
      const changed = {
        name: differentFrom(original.name, 'Game Night', 'Board Night'),
        allowPasswordResets: !original.allowPasswordResets,
        allowUserRegistration: !original.allowUserRegistration,
        allowUsernameChange: !original.allowUsernameChange,
        feedbackReportRetentionDays: differentFrom(original.feedbackReportRetentionDays, 7, 8),
        feedbackReportServerRedactionEnabled: !original.feedbackReportServerRedactionEnabled,
        requireContributionApproval: !original.requireContributionApproval,
        contributionReclaimDays: differentFrom(original.contributionReclaimDays, 7, 8),
        auditLogRetentionDays: differentFrom(original.auditLogRetentionDays, 7, 8),
        reviewGatewayLanguages: !original.reviewGatewayLanguages,
      };

      const { body } = await patch(admin, changed).expect(200);

      expect(body.settings).toMatchObject(changed);
      await expect(readSettings()).resolves.toEqual({ ...original, ...changed });
    });

    it('accepts a century for each day count', async () => {
      const admin = await actors.admin();
      const century = Object.fromEntries(DAY_COUNTS.map((key) => [key, MAX_DAYS]));

      await patch(admin, century).expect(200);

      await expect(readSettings()).resolves.toMatchObject(century);
    });

    it('accepts null for the audit retention, which means unlimited', async () => {
      const admin = await actors.admin();
      await db.client.systemSetting.update({ where: { id: original.id }, data: { auditLogRetentionDays: 30 } });

      await patch(admin, { auditLogRetentionDays: null }).expect(200);

      await expect(readSettings()).resolves.toMatchObject({ auditLogRetentionDays: null });
    });

    it('trims the name', async () => {
      const admin = await actors.admin();

      await patch(admin, { name: '  Game Night Server  ' }).expect(200);

      await expect(readSettings()).resolves.toMatchObject({ name: 'Game Night Server' });
    });

    it('accepts a name at the length limit, measured without its padding', async () => {
      const admin = await actors.admin();
      const name = 'x'.repeat(MAX_NAME_LENGTH);

      await patch(admin, { name: `  ${name}  ` }).expect(200);

      await expect(readSettings()).resolves.toMatchObject({ name });
    });

    it('leaves a setting the body omits unchanged', async () => {
      const admin = await actors.admin();

      await patch(admin, { reviewGatewayLanguages: !original.reviewGatewayLanguages }).expect(200);

      await expect(readSettings()).resolves.toEqual({
        ...original,
        reviewGatewayLanguages: !original.reviewGatewayLanguages,
      });
    });
  });

  describe('refusals', () => {
    const expectRefused = async (admin: SessionActor, body: object) => {
      await patch(admin, body).expect(400);

      await expect(readSettings()).resolves.toEqual(original);
    };

    it.each(DAY_COUNTS)('answers 400 to %s below one day, past a century, or fractional', async (key) => {
      const admin = await actors.admin();

      for (const value of [0, -1, MAX_DAYS + 1, 1.5]) {
        await expectRefused(admin, { [key]: value });
      }
    });

    it.each(NOT_NULLABLE)('answers 400 to null for %s, whose column is not nullable', async (key) => {
      await expectRefused(await actors.admin(), { [key]: null });
    });

    it.each([
      ['an empty name', { name: '' }],
      ['a blank name', { name: '   ' }],
      ['a name past the length limit', { name: 'x'.repeat(MAX_NAME_LENGTH + 1) }],
      ['the retention under its old name', { feedbackRetentionDays: 30 }],
    ])('answers 400 to %s and writes nothing', async (_, body) => {
      await expectRefused(await actors.admin(), body);
    });

    it('answers 404 to an id that names no settings row', async () => {
      const admin = await actors.admin();
      const id = 'no-such-settings-row';

      const { body } = await patch(admin, { allowUsernameChange: !original.allowUsernameChange }, id).expect(404);

      expect(body.message).toBe(`System settings with ID ${id} not found`);
      await expect(readSettings()).resolves.toEqual(original);
    });
  });

  describe('database bounds', () => {
    it.each(DAY_COUNTS)(
      'refuses %s below one day or past a century, from a write that skips the PATCH',
      async (key) => {
        for (const value of [0, MAX_DAYS + 1]) {
          await expect(
            db.client.systemSetting.update({ where: { id: original.id }, data: { [key]: value } }),
          ).rejects.toThrow(/system_settings_\w+_days_range/);
        }

        await expect(readSettings()).resolves.toEqual(original);
      },
    );
  });
});
