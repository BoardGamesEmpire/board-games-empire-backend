import type { Prisma } from '@bge/database';
import { AuthType, PluginCategory, PluginScope } from '@bge/database';
import type { Actors, SessionActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import request from 'supertest';
import { pluginRowData } from '../plugin/plugin-row-fixtures';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import { errorText } from '../support/error-text';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';

/**
 * The two kinds of DataGateway row (#1083). A remote DataGateway has the
 * three connection fields and no plugin. A plugin DataGateway has its plugin
 * and none of the three. Postgres holds a row to one kind or the other, and
 * the admin routes refuse what would turn one kind into the other.
 *
 * No coordinator runs here, so rows are seeded disabled, and no test calls a
 * route that would reach the coordinator for an enabled one.
 */
describe('a plugin DataGateway’s row', () => {
  const baseUrl = requireBaseUrl(process.env);
  const GATEWAYS = '/api/data-gateways';
  const ROW_KIND = 'data_gateways_row_kind';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  let seq = 0;
  const seedPlugin = () =>
    db.client.plugin.create({
      data: pluginRowData({ category: PluginCategory.DataGateway, scope: PluginScope.Server }),
    });

  const CONNECTION = { connectionUrl: 'localhost', connectionPort: 50099, authType: AuthType.None } as const;

  const insert = (data: Partial<Prisma.DataGatewayUncheckedCreateInput>) =>
    db.client.dataGateway.create({
      data: { name: `Row Kind Gateway ${++seq}`, enabled: false, ...data } as Prisma.DataGatewayUncheckedCreateInput,
    });

  /** A plugin and its row, as installing a data-gateway plugin leaves them. */
  const seedPluginRow = async () => {
    const plugin = await seedPlugin();
    return { plugin, row: await insert({ pluginId: plugin.id }) };
  };

  const stored = (id: string) => db.client.dataGateway.findUniqueOrThrow({ where: { id } });

  const failureOf = (attempt: Promise<unknown>) => attempt.then(() => undefined).catch((err: unknown) => err);

  describe('the row’s kind', () => {
    it('refuses a row with a pluginId and connection fields (#1083)', async () => {
      const plugin = await seedPlugin();

      const failure = await failureOf(insert({ pluginId: plugin.id, ...CONNECTION }));

      expect(failure).toBeInstanceOf(Error);
      expect(errorText(failure)).toContain(ROW_KIND);
    });

    it('refuses a remote row missing one connection field (#1083)', async () => {
      const failure = await failureOf(insert({ pluginId: null, ...CONNECTION, connectionPort: null }));

      expect(failure).toBeInstanceOf(Error);
      expect(errorText(failure)).toContain(ROW_KIND);
    });

    it('refuses a plugin row with only some connection fields (#1083)', async () => {
      const plugin = await seedPlugin();

      const failure = await failureOf(insert({ pluginId: plugin.id, connectionUrl: 'localhost' }));

      expect(failure).toBeInstanceOf(Error);
      expect(errorText(failure)).toContain(ROW_KIND);
    });

    it('accepts each whole kind (#1083)', async () => {
      const plugin = await seedPlugin();

      const remote = await insert({ ...CONNECTION });
      const pluginRow = await insert({ pluginId: plugin.id });

      expect(remote).toMatchObject({ pluginId: null, ...CONNECTION });
      expect(pluginRow).toMatchObject({
        pluginId: plugin.id,
        connectionUrl: null,
        connectionPort: null,
        authType: null,
      });
    });

    it('gives a plugin one row (#1083)', async () => {
      const plugin = await seedPlugin();
      await insert({ pluginId: plugin.id });

      const failure = await failureOf(insert({ pluginId: plugin.id }));

      expect(failure).toMatchObject({ code: 'P2002' });
    });
  });

  // The routes answer a readable refusal before the CHECK constraint could
  // fire, which would reach the client as a 500.
  describe('the admin routes', () => {
    let admin: SessionActor;

    beforeEach(async () => {
      admin = await actors.admin();
    });

    it('show a plugin’s row with its pluginId and no connection fields (#1083)', async () => {
      const { plugin, row } = await seedPluginRow();

      const one = await request(baseUrl).get(`${GATEWAYS}/${row.id}`).set(admin.headers).expect(200);
      const list = await request(baseUrl).get(GATEWAYS).set(admin.headers).expect(200);

      const expected = { pluginId: plugin.id, connectionUrl: null, connectionPort: null, authType: null };
      expect(one.body.dataGateway).toMatchObject(expected);
      expect(list.body.dataGateways).toEqual([expect.objectContaining({ id: row.id, ...expected })]);
    });

    it('show a remote row with a null pluginId (#1083)', async () => {
      const row = await insert({ ...CONNECTION });

      const one = await request(baseUrl).get(`${GATEWAYS}/${row.id}`).set(admin.headers).expect(200);

      expect(one.body.dataGateway).toMatchObject({ pluginId: null, ...CONNECTION });
    });

    it.each([
      ['connectionUrl', { connectionUrl: 'localhost' }],
      ['connectionPort', { connectionPort: 50099 }],
      ['authType', { authType: AuthType.None }],
      ['authParameters', { authParameters: { apiKey: 'secret' } }],
    ])('refuse %s on a plugin’s row, and write nothing (#1083)', async (_field, body) => {
      const { row } = await seedPluginRow();

      const response = await request(baseUrl).patch(`${GATEWAYS}/${row.id}`).set(admin.headers).send(body);

      expectErrorEnvelope(response, { status: 422, code: 'DATA_GATEWAY_PLUGIN_CONNECTION_FIELDS' });
      expect(await stored(row.id)).toMatchObject({
        connectionUrl: null,
        connectionPort: null,
        authType: null,
        authParameters: null,
      });
    });

    it('rename a plugin’s row (#1083)', async () => {
      const { plugin, row } = await seedPluginRow();

      const renamed = await request(baseUrl)
        .patch(`${GATEWAYS}/${row.id}`)
        .set(admin.headers)
        .send({ name: 'Renamed Plugin Gateway' })
        .expect(200);

      expect(renamed.body.dataGateway).toMatchObject({ name: 'Renamed Plugin Gateway', pluginId: plugin.id });
    });

    it.each(['connectionUrl', 'connectionPort', 'authType'])(
      'refuse null for a remote row’s %s, and write nothing (#1083)',
      async (field) => {
        const row = await insert({ ...CONNECTION });

        const response = await request(baseUrl)
          .patch(`${GATEWAYS}/${row.id}`)
          .set(admin.headers)
          .send({ [field]: null });

        expectErrorEnvelope(response, { status: 422, code: 'DATA_GATEWAY_CONNECTION_FIELD_REQUIRED' });
        expect(await stored(row.id)).toMatchObject(CONNECTION);
      },
    );

    it('refuse to delete a plugin’s row, which even uninstalling the plugin keeps (#1083)', async () => {
      const { row } = await seedPluginRow();

      const response = await request(baseUrl).delete(`${GATEWAYS}/${row.id}`).set(admin.headers);

      expectErrorEnvelope(response, { status: 409, code: 'DATA_GATEWAY_PLUGIN_ROW_DELETE' });
      expect(await stored(row.id)).toMatchObject({ deletedAt: null, pluginId: row.pluginId });
    });

    // A plugin's row comes from installing the plugin. Neither route takes a
    // pluginId, so the validation pipe refuses a body that carries one.
    it('refuse a pluginId on create and on update (#1083)', async () => {
      const plugin = await seedPlugin();
      const remote = await insert({ ...CONNECTION });

      const created = await request(baseUrl)
        .post(GATEWAYS)
        .set(admin.headers)
        .send({ name: 'Created With A Plugin Id', enabled: false, pluginId: plugin.id, ...CONNECTION });
      const updated = await request(baseUrl)
        .patch(`${GATEWAYS}/${remote.id}`)
        .set(admin.headers)
        .send({ pluginId: plugin.id });

      expectErrorEnvelope(created, { status: 400, code: null });
      expectErrorEnvelope(updated, { status: 400, code: null });
      expect(await db.client.dataGateway.findMany({ where: { pluginId: plugin.id } })).toEqual([]);
    });

    // IsOptional, and PartialType's copy of it on update, skipped null as
    // well as a missing key, so a null reached the non-nullable name and
    // enabled columns as a 500 (#1275).
    it('refuse null for name and enabled on update, and for enabled on create (#1275)', async () => {
      const remote = await insert({ ...CONNECTION });
      const before = await stored(remote.id);
      const name = `Created With A Null Enabled ${remote.id}`;

      const created = await request(baseUrl)
        .post(GATEWAYS)
        .set(admin.headers)
        .send({ name, enabled: null, ...CONNECTION });
      const nullName = await request(baseUrl).patch(`${GATEWAYS}/${remote.id}`).set(admin.headers).send({ name: null });
      const nullEnabled = await request(baseUrl)
        .patch(`${GATEWAYS}/${remote.id}`)
        .set(admin.headers)
        .send({ enabled: null });

      expectErrorEnvelope(created, { status: 400, code: null });
      expectErrorEnvelope(nullName, { status: 400, code: null });
      expectErrorEnvelope(nullEnabled, { status: 400, code: null });
      expect(await stored(remote.id)).toEqual(before);
      expect(await db.client.dataGateway.count({ where: { name } })).toBe(0);
    });
  });
});
