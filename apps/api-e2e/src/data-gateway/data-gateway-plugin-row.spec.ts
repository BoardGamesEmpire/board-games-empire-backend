import { AuthType, PluginCategory, PluginScope, type Prisma } from '@bge/database';
import { pluginRowData } from '../plugin/plugin-row-fixtures';
import { errorText } from '../support/error-text';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * The two kinds of DataGateway row (#1083). A remote DataGateway has the
 * three connection fields and no plugin. A plugin DataGateway has its plugin
 * and none of the three. Postgres holds a row to one kind or the other.
 */
describe('a plugin DataGateway’s row', () => {
  const ROW_KIND = 'data_gateways_row_kind';

  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
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
});
