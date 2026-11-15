import type { Prisma } from '@bge/database';
import { uniqueViolation, uniqueViolationWithoutMeta } from '@bge/database/testing';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { PluginInstallDataGatewayNameConflictError } from './install.errors';
import {
  disablePluginDataGatewayRow,
  findDataGatewayNameHolder,
  placePluginDataGatewayRow,
  pluginDataGatewayName,
} from './plugin-data-gateway-row';

describe('plugin DataGateway row (#1083)', () => {
  let db: MockDatabaseService;

  const tx = (): Prisma.TransactionClient => db as unknown as Prisma.TransactionClient;

  const placement = {
    pluginId: 'plugin-1',
    name: 'Demo Gateway',
    installerId: 'admin-1',
    // The caller's refusal: the installer's here, and an update passes its own.
    nameTaken: (name: string) => new PluginInstallDataGatewayNameConflictError('demo-gateway', name),
  };

  beforeEach(() => {
    db = createMockDatabaseService();
    // The plugin has no row yet, and nothing holds the name.
    db.dataGateway.updateMany.mockResolvedValue({ count: 0 });
    db.dataGateway.findUnique.mockResolvedValue(null);
    db.dataGateway.create.mockResolvedValue({ id: 'gw-1' } as never);
  });

  describe('pluginDataGatewayName', () => {
    it("takes the plugin's display name in the server default locale (#1083)", () => {
      const manifest = buildPluginManifest({ displayName: { en: 'Demo Gateway', de: 'Demo-Gateway' } });

      expect(pluginDataGatewayName(manifest, 'de')).toBe('Demo-Gateway');
      expect(pluginDataGatewayName(manifest, 'en')).toBe('Demo Gateway');
    });
  });

  describe('findDataGatewayNameHolder', () => {
    /** The rows the unique lookups find: by the plugin that owns one, and by the name one holds. */
    const rows = (found: { readonly byPluginId?: string; readonly byName?: string }): void => {
      db.dataGateway.findUnique.mockImplementation(((args: { where: { pluginId?: string; name?: string } }) => {
        const id = args.where.pluginId !== undefined ? found.byPluginId : found.byName;

        return Promise.resolve(id === undefined ? null : { id });
      }) as never);
    };

    it('answers the row holding the name when the plugin has no row of its own (#1083)', async () => {
      rows({ byName: 'gw-other' });

      await expect(findDataGatewayNameHolder(tx(), 'Demo Gateway', 'plugin-1')).resolves.toEqual({ id: 'gw-other' });
    });

    it('answers the row holding the name for a plugin not installed before (#1083)', async () => {
      rows({ byName: 'gw-other' });

      await expect(findDataGatewayNameHolder(tx(), 'Demo Gateway', null)).resolves.toEqual({ id: 'gw-other' });
    });

    it('answers null when no row holds the name (#1083)', async () => {
      rows({});

      await expect(findDataGatewayNameHolder(tx(), 'Demo Gateway', 'plugin-1')).resolves.toBeNull();
    });

    it('answers null for a plugin that kept its row, even when another row took the manifest name since (#1083)', async () => {
      // An admin renamed the kept row, and another row then took the name the
      // manifest gives. A reinstall creates no row, so it would never meet
      // that name, and reporting a conflict here would block nothing real.
      rows({ byPluginId: 'gw-kept', byName: 'gw-other' });

      await expect(findDataGatewayNameHolder(tx(), 'Demo Gateway', 'plugin-1')).resolves.toBeNull();
    });
  });

  describe('placePluginDataGatewayRow', () => {
    it('creates an enabled row for the plugin with no connection fields, created by the installer (#1083)', async () => {
      await placePluginDataGatewayRow(tx(), placement);

      // Exact: a plugin DataGateway runs in the coordinator and has no
      // address, and the row-kind CHECK refuses one that names any.
      expect(db.dataGateway.create).toHaveBeenCalledWith({
        data: { name: 'Demo Gateway', pluginId: 'plugin-1', enabled: true, createdById: 'admin-1' },
      });
    });

    it('enables the row a reinstalled plugin kept and changes nothing else, so an admin rename survives (#1083)', async () => {
      db.dataGateway.updateMany.mockResolvedValue({ count: 1 });

      await placePluginDataGatewayRow(tx(), { ...placement, name: 'The Manifest Name' });

      expect(db.dataGateway.updateMany).toHaveBeenCalledWith({
        where: { pluginId: 'plugin-1' },
        data: { enabled: true },
      });
      expect(db.dataGateway.create).not.toHaveBeenCalled();
      expect(db.dataGateway.update).not.toHaveBeenCalled();
    });

    it('refuses a name another row holds, a deleted row included, and creates nothing (#1083)', async () => {
      // A deleted DataGateway keeps its name (#754), so the read has no
      // deletedAt filter.
      db.dataGateway.findUnique.mockResolvedValue({ id: 'gw-other' } as never);

      const failure = await placePluginDataGatewayRow(tx(), placement).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PluginInstallDataGatewayNameConflictError);
      expect(failure).toMatchObject({ slug: 'demo-gateway', dataGatewayName: 'Demo Gateway' });
      expect(db.dataGateway.findUnique).toHaveBeenCalledWith({ where: { name: 'Demo Gateway' }, select: { id: true } });
      expect(db.dataGateway.create).not.toHaveBeenCalled();
    });

    it.each([
      ['the index name', { index: 'data_gateways_name_key' }],
      ['the column', { fields: ['name'] }],
    ])(
      'refuses the name when the unique index catches a row created after the read, reported by %s (#1083)',
      async (_spelling, constraint) => {
        db.dataGateway.create.mockRejectedValue(
          uniqueViolation({ ...constraint, constraintName: 'data_gateways_name_key' }),
        );

        const failure = await placePluginDataGatewayRow(tx(), placement).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(PluginInstallDataGatewayNameConflictError);
        expect(failure).toMatchObject({ slug: 'demo-gateway', dataGatewayName: 'Demo Gateway' });
      },
    );

    it.each([
      ['on the plugin id', () => uniqueViolation({ index: 'data_gateways_plugin_id_key' })],
      ['it cannot place', () => uniqueViolationWithoutMeta()],
    ])('lets a unique violation %s through as it is (#1083)', async (_case, violation) => {
      const raised = violation();
      db.dataGateway.create.mockRejectedValue(raised);

      await expect(placePluginDataGatewayRow(tx(), placement)).rejects.toBe(raised);
    });
  });

  describe('disablePluginDataGatewayRow', () => {
    it("disables the plugin's row and keeps it, since its game sources hang on it (#1083)", async () => {
      db.dataGateway.updateMany.mockResolvedValue({ count: 1 });

      await disablePluginDataGatewayRow(tx(), 'plugin-1');

      expect(db.dataGateway.updateMany).toHaveBeenCalledWith({
        where: { pluginId: 'plugin-1' },
        data: { enabled: false },
      });
      expect(db.dataGateway.delete).not.toHaveBeenCalled();
      expect(db.dataGateway.deleteMany).not.toHaveBeenCalled();
    });
  });
});
