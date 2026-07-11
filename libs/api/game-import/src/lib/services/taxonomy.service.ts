import { DatabaseService, isPrismaUniqueConstraintError, Prisma } from '@bge/database';
import type { CategoryData, FamilyData, MechanicData } from '@boardgamesempire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import { toSlug } from '../utils/slug';

/**
 * Per-entity Prisma wiring for the shared dedup pipeline. Mechanic, Category,
 * and Family run the identical algorithm and differ only in these closures
 * (delegate + composite-key field names), so each supplies its own while the
 * control flow lives once in {@link TaxonomyUpsertService.resolve}.
 */
interface TaxonomyResolver {
  /** Human label used in the fuzzy-match debug log. */
  label: string;
  /** Canonical table for the pg_trgm fuzzy lookup (a constant identifier — injection-safe). */
  table: Prisma.Sql;
  /** Step 1: gateway alias exact match (gatewayId + externalId) → canonical id. */
  findAlias(): Promise<string | undefined>;
  /** Step 2/4-recovery: canonical slug exact match → id. */
  findBySlug(slug: string): Promise<string | undefined>;
  /** Step 4: create the canonical record + its gateway alias → new id. */
  createCanonical(slug: string): Promise<string>;
  /** Attach the gateway alias to an already-resolved canonical id (steps 2 & 3). */
  upsertAlias(id: string): Promise<unknown>;
}

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

  upsertMechanic(data: MechanicData, gatewayId: string): Promise<string> {
    return this.resolve(data, {
      label: 'Mechanic',
      table: Prisma.raw('mechanics'),
      findAlias: () =>
        this.db.mechanicGatewayAlias
          .findUnique({
            where: { gatewayId_externalId: { gatewayId, externalId: data.externalId } },
            select: { mechanicId: true },
          })
          .then((row) => row?.mechanicId),
      findBySlug: (slug) =>
        this.db.mechanic.findUnique({ where: { slug }, select: { id: true } }).then((row) => row?.id),
      createCanonical: (slug) =>
        this.db.mechanic
          .create({
            data: {
              name: data.name,
              slug,
              gatewayAliases: {
                create: { gatewayId, externalId: data.externalId, externalName: data.name },
              },
            },
            select: { id: true },
          })
          .then((row) => row.id),
      upsertAlias: (mechanicId) =>
        this.db.mechanicGatewayAlias.upsert({
          where: { gatewayId_externalId: { gatewayId, externalId: data.externalId } },
          create: { mechanicId, gatewayId, externalId: data.externalId, externalName: data.name },
          update: {},
        }),
    });
  }

  upsertCategory(data: CategoryData, gatewayId: string): Promise<string> {
    return this.resolve(data, {
      label: 'Category',
      table: Prisma.raw('categories'),
      findAlias: () =>
        this.db.categoryGatewayAlias
          .findUnique({
            where: { gatewayId_externalId: { gatewayId, externalId: data.externalId } },
            select: { categoryId: true },
          })
          .then((row) => row?.categoryId),
      findBySlug: (slug) =>
        this.db.category.findUnique({ where: { slug }, select: { id: true } }).then((row) => row?.id),
      createCanonical: (slug) =>
        this.db.category
          .create({
            data: {
              name: data.name,
              slug,
              gatewayAliases: {
                create: { gatewayId, externalId: data.externalId, externalName: data.name },
              },
            },
            select: { id: true },
          })
          .then((row) => row.id),
      upsertAlias: (categoryId) =>
        this.db.categoryGatewayAlias.upsert({
          where: { gatewayId_externalId: { gatewayId, externalId: data.externalId } },
          create: { categoryId, gatewayId, externalId: data.externalId, externalName: data.name },
          update: {},
        }),
    });
  }

  upsertFamily(data: FamilyData, gatewayId: string): Promise<string> {
    return this.resolve(data, {
      label: 'Family',
      table: Prisma.raw('families'),
      findAlias: () =>
        this.db.familyGatewayAlias
          .findUnique({
            where: { gatewayId_externalId: { gatewayId, externalId: data.externalId } },
            select: { familyId: true },
          })
          .then((row) => row?.familyId),
      findBySlug: (slug) =>
        this.db.family.findUnique({ where: { slug }, select: { id: true } }).then((row) => row?.id),
      createCanonical: (slug) =>
        this.db.family
          .create({
            data: {
              name: data.name,
              slug,
              gatewayAliases: {
                create: { gatewayId, externalId: data.externalId, externalName: data.name },
              },
            },
            select: { id: true },
          })
          .then((row) => row.id),
      upsertAlias: (familyId) =>
        this.db.familyGatewayAlias.upsert({
          where: { gatewayId_externalId: { gatewayId, externalId: data.externalId } },
          create: { familyId, gatewayId, externalId: data.externalId, externalName: data.name },
          update: {},
        }),
    });
  }

  /**
   * The shared 4-step dedup pipeline (cheapest first). Steps 1–3 short-circuit
   * on the first match; step 4 creates the canonical record and recovers from a
   * concurrent create race by re-reading the slug winner (mirrors the game and
   * platform upsert paths).
   */
  private async resolve(data: { name: string }, resolver: TaxonomyResolver): Promise<string> {
    const aliasId = await resolver.findAlias();
    if (aliasId) {
      return aliasId;
    }

    const slug = toSlug(data.name);
    const bySlug = await resolver.findBySlug(slug);
    if (bySlug) {
      await resolver.upsertAlias(bySlug);
      return bySlug;
    }

    const fuzzy = await this.fuzzyFind(resolver.table, data.name);
    if (fuzzy) {
      this.logger.debug(`${resolver.label} fuzzy match: '${data.name}' → id=${fuzzy}`);
      await resolver.upsertAlias(fuzzy);
      return fuzzy;
    }

    try {
      return await resolver.createCanonical(slug);
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        // Another worker won the race — fetch the winner
        const raced = await resolver.findBySlug(slug);
        if (raced) {
          return raced;
        }
      }

      throw error;
    }
  }

  private async fuzzyFind(table: Prisma.Sql, name: string): Promise<string | undefined> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM ${table}
      WHERE similarity(name, ${name}) > 0.85
        AND frozen_at IS NULL
      ORDER BY similarity(name, ${name}) DESC
      LIMIT 1
    `);
    return rows[0]?.id;
  }
}
