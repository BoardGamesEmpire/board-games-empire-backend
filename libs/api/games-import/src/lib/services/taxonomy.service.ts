import { DatabaseService } from '@bge/database';
import type { CategoryData, FamilyData, MechanicData } from '@board-games-empire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import { toSlug } from '../utils/slug';

/**
 * Handles upsert + dedup for Mechanic, Category, and Family.
 *
 * Dedup order (cheapest first):
 *   1. Gateway alias exact match  (gatewayId + externalId)
 *   2. Slug exact match
 *   3. pg_trgm similarity ≥ 0.85
 *   4. Create new canonical record + alias
 */
@Injectable()
export class TaxonomyUpsertService {
  private readonly logger = new Logger(TaxonomyUpsertService.name);

  constructor(private readonly db: DatabaseService) {}

  async upsertMechanic(data: MechanicData, gatewayId: string): Promise<string> {
    const existing = await this.db.mechanicGatewayAlias.findUnique({
      where: { gatewayId_externalId: { gatewayId, externalId: data.externalId } },
      select: { mechanicId: true },
    });

    if (existing) {
      return existing.mechanicId;
    }

    const slug = toSlug(data.name);
    const bySlug = await this.db.mechanic.findUnique({ where: { slug }, select: { id: true } });
    if (bySlug) {
      await this.createMechanicAlias(bySlug.id, data, gatewayId);
      return bySlug.id;
    }

    const fuzzy = await this.fuzzyFindMechanic(data.name);
    if (fuzzy) {
      this.logger.debug(`Mechanic fuzzy match: '${data.name}' → id=${fuzzy}`);
      await this.createMechanicAlias(fuzzy, data, gatewayId);
      return fuzzy;
    }

    const created = await this.db.mechanic.create({
      data: {
        name: data.name,
        slug,
        gatewayAliases: {
          create: { gatewayId, externalId: data.externalId, externalName: data.name },
        },
      },
      select: { id: true },
    });

    return created.id;
  }

  private async fuzzyFindMechanic(name: string): Promise<string | undefined> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM mechanics
      WHERE similarity(name, ${name}) > 0.85
        AND frozen_at IS NULL
      ORDER BY similarity(name, ${name}) DESC
      LIMIT 1
    `;
    return rows[0]?.id;
  }

  private createMechanicAlias(mechanicId: string, data: MechanicData, gatewayId: string) {
    return this.db.mechanicGatewayAlias.create({
      data: {
        mechanicId,
        gatewayId,
        externalId: data.externalId,
        externalName: data.name,
      },
    });
  }

  async upsertCategory(data: CategoryData, gatewayId: string): Promise<string> {
    const existing = await this.db.categoryGatewayAlias.findUnique({
      where: { gatewayId_externalId: { gatewayId, externalId: data.externalId } },
      select: { categoryId: true },
    });

    if (existing) {
      return existing.categoryId;
    }

    const slug = toSlug(data.name);
    const bySlug = await this.db.category.findUnique({ where: { slug }, select: { id: true } });
    if (bySlug) {
      await this.createCategoryAlias(bySlug.id, data, gatewayId);
      return bySlug.id;
    }

    const fuzzy = await this.fuzzyFindCategory(data.name);
    if (fuzzy) {
      this.logger.debug(`Category fuzzy match: '${data.name}' → id=${fuzzy}`);
      await this.createCategoryAlias(fuzzy, data, gatewayId);
      return fuzzy;
    }

    const created = await this.db.category.create({
      data: {
        name: data.name,
        slug,
        gatewayAliases: {
          create: {
            gatewayId,
            externalId: data.externalId,
            externalName: data.name,
          },
        },
      },
      select: { id: true },
    });

    return created.id;
  }

  private async fuzzyFindCategory(name: string): Promise<string | undefined> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM categories
      WHERE similarity(name, ${name}) > 0.85
        AND frozen_at IS NULL
      ORDER BY similarity(name, ${name}) DESC
      LIMIT 1
    `;
    return rows[0]?.id;
  }

  private createCategoryAlias(categoryId: string, data: CategoryData, gatewayId: string) {
    return this.db.categoryGatewayAlias.create({
      data: {
        categoryId,
        gatewayId,
        externalId: data.externalId,
        externalName: data.name,
      },
    });
  }

  async upsertFamily(data: FamilyData, gatewayId: string): Promise<string> {
    const existing = await this.db.familyGatewayAlias.findUnique({
      where: { gatewayId_externalId: { gatewayId, externalId: data.externalId } },
      select: { familyId: true },
    });
    if (existing) {
      return existing.familyId;
    }

    const slug = toSlug(data.name);
    const bySlug = await this.db.family.findUnique({ where: { slug }, select: { id: true } });
    if (bySlug) {
      await this.createFamilyAlias(bySlug.id, data, gatewayId);
      return bySlug.id;
    }

    const fuzzy = await this.fuzzyFindFamily(data.name);
    if (fuzzy) {
      this.logger.debug(`Family fuzzy match: '${data.name}' → id=${fuzzy}`);
      await this.createFamilyAlias(fuzzy, data, gatewayId);
      return fuzzy;
    }

    const created = await this.db.family.create({
      data: {
        name: data.name,
        slug,
        gatewayAliases: {
          create: {
            gatewayId,
            externalId: data.externalId,
            externalName: data.name,
          },
        },
      },
      select: { id: true },
    });
    return created.id;
  }

  private async fuzzyFindFamily(name: string): Promise<string | undefined> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM families
      WHERE similarity(name, ${name}) > 0.85
        AND frozen_at IS NULL
      ORDER BY similarity(name, ${name}) DESC
      LIMIT 1
    `;
    return rows[0]?.id;
  }

  private createFamilyAlias(familyId: string, data: FamilyData, gatewayId: string) {
    return this.db.familyGatewayAlias.create({
      data: {
        familyId,
        gatewayId,
        externalId: data.externalId,
        externalName: data.name,
      },
    });
  }
}
