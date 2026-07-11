import { Prisma } from '@bge/database';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import type { CategoryData, FamilyData, MechanicData } from '@boardgamesempire/proto-gateway';
import { TaxonomyUpsertService } from './taxonomy.service';

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

describe('TaxonomyUpsertService', () => {
  let service: TaxonomyUpsertService;
  let db: MockDatabaseService;

  const GATEWAY_ID = 'gw-bgg';

  beforeEach(async () => {
    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [TaxonomyUpsertService],
    });

    service = module.get(TaxonomyUpsertService);
    db = mockDb;
  });

  afterEach(() => jest.clearAllMocks());

  const mechanic = (overrides: Partial<MechanicData> = {}): MechanicData => ({
    externalId: 'm-1',
    name: 'Worker Placement',
    ...overrides,
  });

  describe('upsertMechanic — shared dedup pipeline', () => {
    it('step 1: returns the linked id on a gateway-alias hit, without touching canonical tables', async () => {
      db.mechanicGatewayAlias.findUnique.mockResolvedValue({ mechanicId: 'mech-42' } as never);

      const id = await service.upsertMechanic(mechanic(), GATEWAY_ID);

      expect(id).toBe('mech-42');
      expect(db.mechanic.findUnique).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.mechanic.create).not.toHaveBeenCalled();
    });

    it('step 2: on a slug hit, links the alias to the existing id and returns it', async () => {
      db.mechanicGatewayAlias.findUnique.mockResolvedValue(null as never);
      db.mechanic.findUnique.mockResolvedValue({ id: 'mech-slug' } as never);
      db.mechanicGatewayAlias.upsert.mockResolvedValue({} as never);

      const id = await service.upsertMechanic(mechanic(), GATEWAY_ID);

      expect(id).toBe('mech-slug');
      expect(db.mechanicGatewayAlias.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ mechanicId: 'mech-slug' }) }),
      );
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.mechanic.create).not.toHaveBeenCalled();
    });

    it('step 3: on a fuzzy (pg_trgm) hit, links the alias and returns the fuzzy id', async () => {
      db.mechanicGatewayAlias.findUnique.mockResolvedValue(null as never);
      db.mechanic.findUnique.mockResolvedValue(null as never);
      db.$queryRaw.mockResolvedValue([{ id: 'mech-fuzzy' }] as never);
      db.mechanicGatewayAlias.upsert.mockResolvedValue({} as never);

      const id = await service.upsertMechanic(mechanic(), GATEWAY_ID);

      expect(id).toBe('mech-fuzzy');
      expect(db.mechanicGatewayAlias.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ mechanicId: 'mech-fuzzy' }) }),
      );
      expect(db.mechanic.create).not.toHaveBeenCalled();
    });

    it('step 4: creates a new canonical record (NFD-normalized slug) when nothing matches', async () => {
      db.mechanicGatewayAlias.findUnique.mockResolvedValue(null as never);
      db.mechanic.findUnique.mockResolvedValue(null as never);
      db.$queryRaw.mockResolvedValue([] as never);
      db.mechanic.create.mockResolvedValue({ id: 'mech-new' } as never);

      const id = await service.upsertMechanic(mechanic({ name: 'Café Deck-Building' }), GATEWAY_ID);

      expect(id).toBe('mech-new');
      expect(db.mechanic.create).toHaveBeenCalledWith(
        expect.objectContaining({
          // shared toSlug strips diacritics via NFD — the whole point of #26
          data: expect.objectContaining({ name: 'Café Deck-Building', slug: 'cafe-deck-building' }),
        }),
      );
    });

    it('step 4 recovery: re-fetches the slug winner when create trips the unique constraint', async () => {
      db.mechanicGatewayAlias.findUnique.mockResolvedValue(null as never);
      db.mechanic.findUnique
        .mockResolvedValueOnce(null as never) // initial slug miss
        .mockResolvedValueOnce({ id: 'mech-raced' } as never); // recovery re-fetch finds the winner
      db.$queryRaw.mockResolvedValue([] as never);
      db.mechanic.create.mockRejectedValue(uniqueViolation());

      const id = await service.upsertMechanic(mechanic(), GATEWAY_ID);

      expect(id).toBe('mech-raced');
    });

    it('rethrows the unique error when the slug winner is still absent on re-fetch', async () => {
      const err = uniqueViolation();
      db.mechanicGatewayAlias.findUnique.mockResolvedValue(null as never);
      db.mechanic.findUnique.mockResolvedValue(null as never); // both lookups miss
      db.$queryRaw.mockResolvedValue([] as never);
      db.mechanic.create.mockRejectedValue(err);

      await expect(service.upsertMechanic(mechanic(), GATEWAY_ID)).rejects.toBe(err);
    });

    it('rethrows a non-unique create failure without attempting recovery', async () => {
      const boom = new Error('connection reset');
      db.mechanicGatewayAlias.findUnique.mockResolvedValue(null as never);
      db.mechanic.findUnique.mockResolvedValue(null as never);
      db.$queryRaw.mockResolvedValue([] as never);
      db.mechanic.create.mockRejectedValue(boom);

      await expect(service.upsertMechanic(mechanic(), GATEWAY_ID)).rejects.toBe(boom);
      expect(db.mechanic.findUnique).toHaveBeenCalledTimes(1); // no recovery re-fetch
    });
  });

  // Guards the closure wiring: after collapsing three copies into one core, each
  // entry must still read its OWN alias/canonical delegate and return its OWN FK
  // field — a mis-wired closure is exactly the silent-corruption risk of #22.
  describe('per-entity delegate wiring', () => {
    it('upsertCategory resolves via categoryGatewayAlias.categoryId', async () => {
      db.categoryGatewayAlias.findUnique.mockResolvedValue({ categoryId: 'cat-1' } as never);

      const category: CategoryData = { externalId: 'c-1', name: 'Strategy' };
      const id = await service.upsertCategory(category, GATEWAY_ID);

      expect(id).toBe('cat-1');
      expect(db.categoryGatewayAlias.findUnique).toHaveBeenCalled();
      expect(db.mechanicGatewayAlias.findUnique).not.toHaveBeenCalled();
      expect(db.familyGatewayAlias.findUnique).not.toHaveBeenCalled();
    });

    it('upsertFamily resolves via familyGatewayAlias.familyId', async () => {
      db.familyGatewayAlias.findUnique.mockResolvedValue({ familyId: 'fam-1' } as never);

      const family: FamilyData = { externalId: 'f-1', name: 'Catan' };
      const id = await service.upsertFamily(family, GATEWAY_ID);

      expect(id).toBe('fam-1');
      expect(db.familyGatewayAlias.findUnique).toHaveBeenCalled();
      expect(db.mechanicGatewayAlias.findUnique).not.toHaveBeenCalled();
      expect(db.categoryGatewayAlias.findUnique).not.toHaveBeenCalled();
    });

    it('creates a family canonical row (not a mechanic/category one) on the create path', async () => {
      db.familyGatewayAlias.findUnique.mockResolvedValue(null as never);
      db.family.findUnique.mockResolvedValue(null as never);
      db.$queryRaw.mockResolvedValue([] as never);
      db.family.create.mockResolvedValue({ id: 'fam-new' } as never);

      const family: FamilyData = { externalId: 'f-2', name: 'Pandemic' };
      const id = await service.upsertFamily(family, GATEWAY_ID);

      expect(id).toBe('fam-new');
      expect(db.family.create).toHaveBeenCalled();
      expect(db.mechanic.create).not.toHaveBeenCalled();
      expect(db.category.create).not.toHaveBeenCalled();
    });
  });
});
