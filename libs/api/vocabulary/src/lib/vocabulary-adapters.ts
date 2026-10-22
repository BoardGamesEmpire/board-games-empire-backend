import { DatabaseService, Prisma, VocabularyLinkOrigin, VocabularyLinkStatus } from '@bge/database';
import type { PaginatedRows } from '@bge/shared';
import type {
  EntryOf,
  ReviewedVocabularyKind,
  VocabularyKind,
  VocabularyLinkView,
  VocabularyRecordView,
} from './vocabulary.types';

/** A link as matching reads it: its status, and its record while it has one. */
export interface LinkResolution {
  status: VocabularyLinkStatus;
  recordId: string | null;
}

/** What a new link is written with. */
export interface LinkWrite extends LinkResolution {
  origin: VocabularyLinkOrigin;
}

/** The system setting that holds a vocabulary's review switch. */
export type ReviewSetting = 'reviewGatewayPlatforms' | 'reviewGatewayCategories' | 'reviewGatewayMechanics';

/** The filter and page an admin's review list asks for. */
export interface ReviewQuery {
  gatewayId: string;
  statuses: readonly VocabularyLinkStatus[];
  skip: number;
  pageSize: number;
}

/**
 * One vocabulary's Prisma wiring for the shared matching (#718), built on the
 * taxonomy resolver import used before. The vocabularies differ only in their
 * tables, their link's record field and what a platform carries besides its
 * name, so each supplies these and the control flow lives once, in
 * VocabularyLinkService.
 */
export interface VocabularyAdapter<K extends VocabularyKind> {
  /** The record's name in log lines. */
  label: string;
  /** The record table for the pg_trgm lookup (a constant identifier), or null: platforms match by slug only. */
  similarityTable: Prisma.Sql | null;
  /** The setting that parks a miss as Pending, or null: families have none. */
  reviewSetting: ReviewSetting | null;
  /** The DataGateway's link for the entry, if it has one. */
  findLink(db: DatabaseService, gatewayId: string, externalId: string): Promise<LinkResolution | null>;
  findBySlug(db: DatabaseService, slug: string): Promise<string | undefined>;
  /** Creates the record and its Resolved link in one statement, and resolves to the record's id. */
  createWithLink(
    db: DatabaseService,
    gatewayId: string,
    entry: EntryOf<K>,
    slug: string,
    origin: VocabularyLinkOrigin,
  ): Promise<string>;
  /**
   * Creates the link unless another writer made it first, and resolves to the
   * link as it stands. Never rewrites an existing link.
   */
  upsertLink(db: DatabaseService, gatewayId: string, entry: EntryOf<K>, link: LinkWrite): Promise<LinkResolution>;
}

/** The wiring a vocabulary with review adds: accept, and the admin's review list (#715). */
export interface ReviewedVocabularyAdapter<K extends ReviewedVocabularyKind> extends VocabularyAdapter<K> {
  reviewSetting: ReviewSetting;
  /** A link by id, with the entry its supplied fields rebuild. */
  findSupplied(
    db: DatabaseService,
    linkId: string,
  ): Promise<{ status: VocabularyLinkStatus; entry: EntryOf<K> } | null>;
  /**
   * Creates the record alone, for a link that already exists: a Pending one
   * holds the DataGateway's key, so its record can't be made with a new link.
   */
  createRecord(db: DatabaseService, entry: EntryOf<K>, slug: string): Promise<string>;
  /** Links a link to `recordId` only while it's still Pending. Resolves to whether it did. */
  settlePending(db: DatabaseService, linkId: string, recordId: string): Promise<boolean>;
  recordExists(db: DatabaseService, recordId: string): Promise<boolean>;
  /** One page of links, and their count, from one REPEATABLE READ snapshot. */
  list(db: DatabaseService, query: ReviewQuery): Promise<PaginatedRows<VocabularyLinkView>>;
  /** A link, found only under its own DataGateway. */
  findOwned(db: DatabaseService, gatewayId: string, linkId: string): Promise<VocabularyLinkView | null>;
  /** An admin's decision, whatever the link's status. */
  decide(db: DatabaseService, gatewayId: string, linkId: string, decision: LinkResolution): Promise<VocabularyLinkView>;
}

const RECORD_VIEW_SELECT = { id: true, name: true, slug: true } as const;

/** The columns every reviewed link has, as its view shows them. */
const LINK_VIEW_COLUMNS = {
  id: true,
  gatewayId: true,
  externalId: true,
  status: true,
  origin: true,
  suppliedName: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** By supplied name, which a DataGateway may repeat, so the id breaks the tie and keeps pages stable. */
const REVIEW_ORDER = [{ suppliedName: 'asc' as const }, { id: 'asc' as const }];

const pendingOnly = (linkId: string) => ({ id: linkId, status: VocabularyLinkStatus.Pending });

const key = (gatewayId: string, externalId: string) => ({ gatewayId_externalId: { gatewayId, externalId } });

const whereReviewed = ({ gatewayId, statuses }: ReviewQuery) => ({ gatewayId, status: { in: [...statuses] } });

/** The rows and their count from one snapshot, so `total` agrees with the rows while a list job writes links. */
const inOneSnapshot = async <Row>(
  db: DatabaseService,
  rows: Prisma.PrismaPromise<Row[]>,
  total: Prisma.PrismaPromise<number>,
): Promise<PaginatedRows<Row>> => {
  const [found, count] = await db.$transaction([rows, total], {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });

  return { rows: found, total: count };
};

/** A category or mechanic link's view: no abbreviation or platform type. */
const namedView = <Row extends Omit<VocabularyLinkView, 'record' | 'suppliedAbbreviation' | 'suppliedPlatformType'>>(
  row: Row,
  record: VocabularyRecordView | null,
): VocabularyLinkView => ({
  id: row.id,
  gatewayId: row.gatewayId,
  externalId: row.externalId,
  status: row.status,
  origin: row.origin,
  record,
  suppliedName: row.suppliedName,
  suppliedAbbreviation: null,
  suppliedPlatformType: null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const pageOf = <Row, View>(page: PaginatedRows<Row>, toView: (row: Row) => View): PaginatedRows<View> => ({
  rows: page.rows.map(toView),
  total: page.total,
});

const PLATFORM_LINK_VIEW_SELECT = {
  ...LINK_VIEW_COLUMNS,
  suppliedAbbreviation: true,
  suppliedPlatformType: true,
  platform: { select: RECORD_VIEW_SELECT },
} satisfies Prisma.PlatformGatewayLinkSelect;

const platformView = ({
  platform,
  ...row
}: Prisma.PlatformGatewayLinkGetPayload<{ select: typeof PLATFORM_LINK_VIEW_SELECT }>): VocabularyLinkView => ({
  ...row,
  record: platform,
});

const platforms: ReviewedVocabularyAdapter<'platform'> = {
  label: 'Platform',
  similarityTable: null,
  reviewSetting: 'reviewGatewayPlatforms',

  findLink: (db, gatewayId, externalId) =>
    db.platformGatewayLink
      .findUnique({ where: key(gatewayId, externalId), select: { status: true, platformId: true } })
      .then((row) => row && { status: row.status, recordId: row.platformId }),

  findBySlug: (db, slug) => db.platform.findUnique({ where: { slug }, select: { id: true } }).then((row) => row?.id),

  createWithLink: (db, gatewayId, entry, slug, origin) =>
    db.platform
      .create({
        data: {
          name: entry.name,
          slug,
          abbreviation: entry.abbreviation ?? null,
          platformType: entry.platformType,
          gatewayLinks: {
            create: {
              gatewayId,
              externalId: entry.externalId,
              status: VocabularyLinkStatus.Resolved,
              origin,
              suppliedName: entry.name,
              suppliedAbbreviation: entry.abbreviation ?? null,
              suppliedPlatformType: entry.platformType,
            },
          },
        },
        select: { id: true },
      })
      .then((row) => row.id),

  upsertLink: (db, gatewayId, entry, link) =>
    db.platformGatewayLink
      .upsert({
        where: key(gatewayId, entry.externalId),
        create: {
          platformId: link.recordId,
          gatewayId,
          externalId: entry.externalId,
          status: link.status,
          origin: link.origin,
          suppliedName: entry.name,
          suppliedAbbreviation: entry.abbreviation ?? null,
          suppliedPlatformType: entry.platformType,
        },
        update: {},
        select: { status: true, platformId: true },
      })
      .then((row) => ({ status: row.status, recordId: row.platformId })),

  findSupplied: (db, linkId) =>
    db.platformGatewayLink
      .findUnique({
        where: { id: linkId },
        select: {
          status: true,
          externalId: true,
          suppliedName: true,
          suppliedAbbreviation: true,
          suppliedPlatformType: true,
        },
      })
      .then(
        (row) =>
          row && {
            status: row.status,
            entry: {
              externalId: row.externalId,
              name: row.suppliedName,
              abbreviation: row.suppliedAbbreviation ?? undefined,
              platformType: row.suppliedPlatformType,
            },
          },
      ),

  createRecord: (db, entry, slug) =>
    db.platform
      .create({
        data: { name: entry.name, slug, abbreviation: entry.abbreviation ?? null, platformType: entry.platformType },
        select: { id: true },
      })
      .then((row) => row.id),

  settlePending: (db, linkId, recordId) =>
    db.platformGatewayLink
      .updateMany({ where: pendingOnly(linkId), data: { status: VocabularyLinkStatus.Resolved, platformId: recordId } })
      .then(({ count }) => count > 0),

  recordExists: (db, recordId) =>
    db.platform.findUnique({ where: { id: recordId }, select: { id: true } }).then((row) => row !== null),

  list: (db, query) =>
    inOneSnapshot(
      db,
      db.platformGatewayLink.findMany({
        where: whereReviewed(query),
        orderBy: REVIEW_ORDER,
        skip: query.skip,
        take: query.pageSize,
        select: PLATFORM_LINK_VIEW_SELECT,
      }),
      db.platformGatewayLink.count({ where: whereReviewed(query) }),
    ).then((page) => pageOf(page, platformView)),

  findOwned: (db, gatewayId, linkId) =>
    db.platformGatewayLink
      .findUnique({ where: { id: linkId, gatewayId }, select: PLATFORM_LINK_VIEW_SELECT })
      .then((row) => row && platformView(row)),

  decide: (db, gatewayId, linkId, decision) =>
    db.platformGatewayLink
      .update({
        where: { id: linkId, gatewayId },
        data: { status: decision.status, platformId: decision.recordId },
        select: PLATFORM_LINK_VIEW_SELECT,
      })
      .then(platformView),
};

const CATEGORY_LINK_VIEW_SELECT = {
  ...LINK_VIEW_COLUMNS,
  category: { select: RECORD_VIEW_SELECT },
} satisfies Prisma.CategoryGatewayLinkSelect;

const categoryView = (
  row: Prisma.CategoryGatewayLinkGetPayload<{ select: typeof CATEGORY_LINK_VIEW_SELECT }>,
): VocabularyLinkView => namedView(row, row.category);

const categories: ReviewedVocabularyAdapter<'category'> = {
  label: 'Category',
  similarityTable: Prisma.raw('categories'),
  reviewSetting: 'reviewGatewayCategories',

  findLink: (db, gatewayId, externalId) =>
    db.categoryGatewayLink
      .findUnique({ where: key(gatewayId, externalId), select: { status: true, categoryId: true } })
      .then((row) => row && { status: row.status, recordId: row.categoryId }),

  findBySlug: (db, slug) => db.category.findUnique({ where: { slug }, select: { id: true } }).then((row) => row?.id),

  createWithLink: (db, gatewayId, entry, slug, origin) =>
    db.category
      .create({
        data: {
          name: entry.name,
          slug,
          gatewayLinks: {
            create: {
              gatewayId,
              externalId: entry.externalId,
              suppliedName: entry.name,
              status: VocabularyLinkStatus.Resolved,
              origin,
            },
          },
        },
        select: { id: true },
      })
      .then((row) => row.id),

  upsertLink: (db, gatewayId, entry, link) =>
    db.categoryGatewayLink
      .upsert({
        where: key(gatewayId, entry.externalId),
        create: {
          gatewayId,
          externalId: entry.externalId,
          suppliedName: entry.name,
          categoryId: link.recordId,
          status: link.status,
          origin: link.origin,
        },
        update: {},
        select: { status: true, categoryId: true },
      })
      .then((row) => ({ status: row.status, recordId: row.categoryId })),

  findSupplied: (db, linkId) =>
    db.categoryGatewayLink
      .findUnique({ where: { id: linkId }, select: { status: true, externalId: true, suppliedName: true } })
      .then((row) => row && { status: row.status, entry: { externalId: row.externalId, name: row.suppliedName } }),

  createRecord: (db, entry, slug) =>
    db.category.create({ data: { name: entry.name, slug }, select: { id: true } }).then((row) => row.id),

  settlePending: (db, linkId, recordId) =>
    db.categoryGatewayLink
      .updateMany({ where: pendingOnly(linkId), data: { status: VocabularyLinkStatus.Resolved, categoryId: recordId } })
      .then(({ count }) => count > 0),

  recordExists: (db, recordId) =>
    db.category.findUnique({ where: { id: recordId }, select: { id: true } }).then((row) => row !== null),

  list: (db, query) =>
    inOneSnapshot(
      db,
      db.categoryGatewayLink.findMany({
        where: whereReviewed(query),
        orderBy: REVIEW_ORDER,
        skip: query.skip,
        take: query.pageSize,
        select: CATEGORY_LINK_VIEW_SELECT,
      }),
      db.categoryGatewayLink.count({ where: whereReviewed(query) }),
    ).then((page) => pageOf(page, categoryView)),

  findOwned: (db, gatewayId, linkId) =>
    db.categoryGatewayLink
      .findUnique({ where: { id: linkId, gatewayId }, select: CATEGORY_LINK_VIEW_SELECT })
      .then((row) => row && categoryView(row)),

  decide: (db, gatewayId, linkId, decision) =>
    db.categoryGatewayLink
      .update({
        where: { id: linkId, gatewayId },
        data: { status: decision.status, categoryId: decision.recordId },
        select: CATEGORY_LINK_VIEW_SELECT,
      })
      .then(categoryView),
};

const MECHANIC_LINK_VIEW_SELECT = {
  ...LINK_VIEW_COLUMNS,
  mechanic: { select: RECORD_VIEW_SELECT },
} satisfies Prisma.MechanicGatewayLinkSelect;

const mechanicView = (
  row: Prisma.MechanicGatewayLinkGetPayload<{ select: typeof MECHANIC_LINK_VIEW_SELECT }>,
): VocabularyLinkView => namedView(row, row.mechanic);

const mechanics: ReviewedVocabularyAdapter<'mechanic'> = {
  label: 'Mechanic',
  similarityTable: Prisma.raw('mechanics'),
  reviewSetting: 'reviewGatewayMechanics',

  findLink: (db, gatewayId, externalId) =>
    db.mechanicGatewayLink
      .findUnique({ where: key(gatewayId, externalId), select: { status: true, mechanicId: true } })
      .then((row) => row && { status: row.status, recordId: row.mechanicId }),

  findBySlug: (db, slug) => db.mechanic.findUnique({ where: { slug }, select: { id: true } }).then((row) => row?.id),

  createWithLink: (db, gatewayId, entry, slug, origin) =>
    db.mechanic
      .create({
        data: {
          name: entry.name,
          slug,
          gatewayLinks: {
            create: {
              gatewayId,
              externalId: entry.externalId,
              suppliedName: entry.name,
              status: VocabularyLinkStatus.Resolved,
              origin,
            },
          },
        },
        select: { id: true },
      })
      .then((row) => row.id),

  upsertLink: (db, gatewayId, entry, link) =>
    db.mechanicGatewayLink
      .upsert({
        where: key(gatewayId, entry.externalId),
        create: {
          gatewayId,
          externalId: entry.externalId,
          suppliedName: entry.name,
          mechanicId: link.recordId,
          status: link.status,
          origin: link.origin,
        },
        update: {},
        select: { status: true, mechanicId: true },
      })
      .then((row) => ({ status: row.status, recordId: row.mechanicId })),

  findSupplied: (db, linkId) =>
    db.mechanicGatewayLink
      .findUnique({ where: { id: linkId }, select: { status: true, externalId: true, suppliedName: true } })
      .then((row) => row && { status: row.status, entry: { externalId: row.externalId, name: row.suppliedName } }),

  createRecord: (db, entry, slug) =>
    db.mechanic.create({ data: { name: entry.name, slug }, select: { id: true } }).then((row) => row.id),

  settlePending: (db, linkId, recordId) =>
    db.mechanicGatewayLink
      .updateMany({ where: pendingOnly(linkId), data: { status: VocabularyLinkStatus.Resolved, mechanicId: recordId } })
      .then(({ count }) => count > 0),

  recordExists: (db, recordId) =>
    db.mechanic.findUnique({ where: { id: recordId }, select: { id: true } }).then((row) => row !== null),

  list: (db, query) =>
    inOneSnapshot(
      db,
      db.mechanicGatewayLink.findMany({
        where: whereReviewed(query),
        orderBy: REVIEW_ORDER,
        skip: query.skip,
        take: query.pageSize,
        select: MECHANIC_LINK_VIEW_SELECT,
      }),
      db.mechanicGatewayLink.count({ where: whereReviewed(query) }),
    ).then((page) => pageOf(page, mechanicView)),

  findOwned: (db, gatewayId, linkId) =>
    db.mechanicGatewayLink
      .findUnique({ where: { id: linkId, gatewayId }, select: MECHANIC_LINK_VIEW_SELECT })
      .then((row) => row && mechanicView(row)),

  decide: (db, gatewayId, linkId, decision) =>
    db.mechanicGatewayLink
      .update({
        where: { id: linkId, gatewayId },
        data: { status: decision.status, mechanicId: decision.recordId },
        select: MECHANIC_LINK_VIEW_SELECT,
      })
      .then(mechanicView),
};

/**
 * Families are matched as the others are, but their link has no status: no
 * DataGateway lists them, so nothing parks one for review (#718). Every
 * family link names its family, so it reads as Resolved.
 */
const families: VocabularyAdapter<'family'> = {
  label: 'Family',
  similarityTable: Prisma.raw('families'),
  reviewSetting: null,

  findLink: (db, gatewayId, externalId) =>
    db.familyGatewayLink
      .findUnique({ where: key(gatewayId, externalId), select: { familyId: true } })
      .then((row) => row && { status: VocabularyLinkStatus.Resolved, recordId: row.familyId }),

  findBySlug: (db, slug) => db.family.findUnique({ where: { slug }, select: { id: true } }).then((row) => row?.id),

  createWithLink: (db, gatewayId, entry, slug) =>
    db.family
      .create({
        data: {
          name: entry.name,
          slug,
          gatewayLinks: { create: { gatewayId, externalId: entry.externalId, externalName: entry.name } },
        },
        select: { id: true },
      })
      .then((row) => row.id),

  upsertLink: (db, gatewayId, entry, link) => {
    if (!link.recordId) {
      return Promise.reject(new Error(`A family link always names its family; ${entry.externalId} names none`));
    }

    return db.familyGatewayLink
      .upsert({
        where: key(gatewayId, entry.externalId),
        create: { familyId: link.recordId, gatewayId, externalId: entry.externalId, externalName: entry.name },
        update: {},
        select: { familyId: true },
      })
      .then((row) => ({ status: VocabularyLinkStatus.Resolved, recordId: row.familyId }));
  },
};

export const REVIEWED_ADAPTERS: { readonly [K in ReviewedVocabularyKind]: ReviewedVocabularyAdapter<K> } = {
  platform: platforms,
  category: categories,
  mechanic: mechanics,
};

export const ADAPTERS: { readonly [K in VocabularyKind]: VocabularyAdapter<K> } = {
  ...REVIEWED_ADAPTERS,
  family: families,
};
