import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { buildPluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { PLUGIN_ARTIFACT_TTL_MS, PluginArtifactStore } from './plugin-artifact.store';

describe('PluginArtifactStore (#1094)', () => {
  let db: MockDatabaseService;
  let store: PluginArtifactStore;
  const sha256 = buildPluginArtifactSha256('a');
  const now = new Date('2026-11-05T12:00:00.000Z');
  const expiresAt = new Date(now.getTime() + PLUGIN_ARTIFACT_TTL_MS);

  const row = () => ({
    sha256,
    slug: 'demo',
    version: '1.0.0',
    compressedBytes: 1234,
    url: null,
    registrySlug: null,
    receivedById: null,
    receivedAt: now,
    expiresAt,
  });

  beforeEach(() => {
    db = createMockDatabaseService();
    store = new PluginArtifactStore(db as never);
  });

  it('an artifact expires 7 days after it is received (#1094)', () => {
    expect(PLUGIN_ARTIFACT_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  describe('recordReceived', () => {
    const input = {
      sha256,
      slug: 'demo',
      version: '1.0.0',
      compressedBytes: 1234,
      url: 'https://example.test/demo.tgz',
      registrySlug: 'official',
      receivedById: 'user-1',
    };

    it('the first post creates the row with every field and an expiry a week out (#1094)', async () => {
      db.pluginArtifact.upsert.mockResolvedValue(row());

      await store.recordReceived(input, now);

      expect(db.pluginArtifact.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { sha256 },
          create: { ...input, receivedAt: now, expiresAt },
        }),
      );
    });

    it('posting again moves the expiry and the link (#1094)', async () => {
      const again = {
        ...input,
        url: 'https://mirror.example.test/demo.tgz',
        registrySlug: null,
        receivedById: 'user-2',
      };
      db.pluginArtifact.upsert.mockResolvedValue(row());

      await store.recordReceived(again, now);

      const [{ update }] = db.pluginArtifact.upsert.mock.calls[0] as [{ update: Record<string, unknown> }];
      expect(update).toEqual({
        expiresAt,
        url: 'https://mirror.example.test/demo.tgz',
        registrySlug: null,
        receivedById: 'user-2',
        receivedAt: now,
      });
    });
  });

  describe('findLive', () => {
    it('reads only a row that has not expired (#1094)', async () => {
      db.pluginArtifact.findFirst.mockResolvedValue(null);

      await expect(store.findLive(sha256, now)).resolves.toBeNull();
      expect(db.pluginArtifact.findFirst).toHaveBeenCalledWith({ where: { sha256, expiresAt: { gt: now } } });
    });
  });

  describe('refreshForInstall', () => {
    it('refreshing an expired artifact finds nothing (#1094)', async () => {
      db.pluginArtifact.updateMany.mockResolvedValue({ count: 0 });

      await expect(store.refreshForInstall(sha256, now)).resolves.toBeNull();

      expect(db.pluginArtifact.updateMany).toHaveBeenCalledWith({
        where: { sha256, expiresAt: { gt: now } },
        data: { expiresAt },
      });
      expect(db.pluginArtifact.findUnique).not.toHaveBeenCalled();
    });

    it('a live artifact is refreshed and read back (#1094)', async () => {
      const found = row();
      db.pluginArtifact.updateMany.mockResolvedValue({ count: 1 });
      db.pluginArtifact.findUnique.mockResolvedValue(found);

      await expect(store.refreshForInstall(sha256, now)).resolves.toBe(found);
      expect(db.pluginArtifact.findUnique).toHaveBeenCalledWith({ where: { sha256 } });
    });
  });

  describe('remove', () => {
    it('deletes by checksum and tolerates a missing row (#1094)', async () => {
      db.pluginArtifact.deleteMany.mockResolvedValue({ count: 0 });

      await expect(store.remove(sha256)).resolves.toBeUndefined();
      expect(db.pluginArtifact.deleteMany).toHaveBeenCalledWith({ where: { sha256 } });
    });
  });

  describe('removeExpired', () => {
    it('deletes every row whose expiry has come, the instant itself included, and says how many (#1094)', async () => {
      db.pluginArtifact.deleteMany.mockResolvedValue({ count: 2 });

      await expect(store.removeExpired(now)).resolves.toBe(2);
      // `lte`, where findLive and refreshForInstall read `gt`: the three agree
      // on the instant a row expires.
      expect(db.pluginArtifact.deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lte: now } } });
    });
  });
});
