import {
  DatabaseService,
  isPrismaUniqueConstraintError,
  Prisma,
  VocabularyLinkOrigin,
  VocabularyLinkStatus,
} from '@bge/database';
import { Injectable, Logger } from '@nestjs/common';
import { toSlug } from './slug';
import {
  ADAPTERS,
  REVIEWED_ADAPTERS,
  type LinkResolution,
  type LinkWrite,
  type ReviewedVocabularyAdapter,
  type VocabularyAdapter,
} from './vocabulary-adapters';
import type { AcceptOutcome, EntryOf, LoadSummary, ReviewedVocabularyKind, VocabularyKind } from './vocabulary.types';

/** How one entry was settled, and the record it resolves to, if any. */
interface Resolution {
  outcome: keyof LoadSummary;
  recordId: string | null;
}

const recordOf = (link: LinkResolution): string | null =>
  link.status === VocabularyLinkStatus.Resolved ? link.recordId : null;

const isBlank = (value: string | undefined): boolean => !value?.trim();

/**
 * Matches the platforms, categories, mechanics and families a DataGateway
 * sends to records, through each vocabulary's DataGateway link (#718).
 * Import and the list jobs share it, so an entry is matched the same way
 * whichever meets it first:
 *
 *  1. An existing link decides, and is never rewritten. A Resolved one gives
 *     its record; a Pending or Ignored one gives none, so import leaves the
 *     entry out until an admin settles it (#715).
 *  2. A record with the entry's slug is linked to.
 *  3. Except for platforms, which match by slug only, the record of the most
 *     similar name is linked to, when its similarity is above 0.85 and it
 *     isn't frozen.
 *  4. While the vocabulary's review setting is on, the entry waits as a
 *     Pending link with no record. Families have no review setting.
 *  5. Otherwise the record and its Resolved link are created together, as
 *     import created them before.
 *
 * Every link is written create-only, so a link another writer made first,
 * an admin's decision included, stands, and the entry resolves as that link
 * says. A record another writer created first under the same slug is linked
 * to rather than duplicated.
 */
@Injectable()
export class VocabularyLinkService {
  private readonly logger = new Logger(VocabularyLinkService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * The record an imported entry resolves to, or null while its link is
   * Pending or Ignored. A new link is written with origin Import.
   */
  async resolveForImport<K extends VocabularyKind>(
    kind: K,
    gatewayId: string,
    entry: EntryOf<K>,
  ): Promise<string | null> {
    const adapter = ADAPTERS[kind] as VocabularyAdapter<K>;
    // Read only once the entry has missed every match.
    const review = () => this.reviewRequired(adapter);

    const { recordId } = await this.resolve(adapter, gatewayId, entry, VocabularyLinkOrigin.Import, review);
    return recordId;
  }

  /**
   * A list job's section: links each entry the DataGateway lists, with
   * origin Interview. An entry with no external id or name can't be linked,
   * and is skipped. Once `signal` aborts, as when the DataGateway's
   * connection is replaced, no further write starts, even for the entry
   * under way, and the abort's reason is thrown.
   */
  async load<K extends ReviewedVocabularyKind>(
    kind: K,
    gatewayId: string,
    entries: readonly EntryOf<K>[],
    signal?: AbortSignal,
  ): Promise<LoadSummary> {
    const adapter = ADAPTERS[kind] as VocabularyAdapter<K>;
    const reviewing = await this.reviewRequired(adapter);
    const review = async () => reviewing;
    const summary: LoadSummary = { created: 0, matched: 0, pending: 0, kept: 0 };
    let skipped = 0;

    for (const entry of entries) {
      signal?.throwIfAborted();
      if (isBlank(entry.externalId) || isBlank(entry.name)) {
        this.logger.warn(
          `DataGateway ${gatewayId} listed a ${adapter.label.toLowerCase()} it can't be linked by ` +
            `(externalId='${entry.externalId}', name='${entry.name}'); skipping it`,
        );
        skipped++;
        continue;
      }

      const { outcome } = await this.resolve(adapter, gatewayId, entry, VocabularyLinkOrigin.Interview, review, signal);
      summary[outcome]++;
    }

    this.logger.log(
      `${adapter.label} section for DataGateway ${gatewayId}: ${entries.length} entries — ` +
        `${summary.created} created, ${summary.matched} matched, ${summary.pending} pending review, ` +
        `${summary.kept} already linked, ${skipped} skipped`,
    );

    return summary;
  }

  /**
   * An admin's accept of a Pending link (#715): rebuilds the entry from what
   * the DataGateway supplied and settles it as it would be without review,
   * linking to a record created since it was parked rather than making a
   * second one. The link is written only while it's still Pending, so one an
   * admin or another accept settled first is refused.
   */
  async acceptPending<K extends ReviewedVocabularyKind>(kind: K, linkId: string): Promise<AcceptOutcome> {
    const adapter = REVIEWED_ADAPTERS[kind] as ReviewedVocabularyAdapter<K>;
    const stored = await adapter.findSupplied(this.db, linkId);
    if (stored?.status !== VocabularyLinkStatus.Pending) {
      return { accepted: false, reason: 'not_pending' };
    }

    const { entry } = stored;
    const slug = toSlug(entry.name);
    const recordId = (await this.match(adapter, slug, entry.name)) ?? (await this.createRecord(adapter, entry, slug));

    if (!(await adapter.settlePending(this.db, linkId, recordId))) {
      return { accepted: false, reason: 'not_pending' };
    }

    this.logger.log(`Accepted Pending ${adapter.label.toLowerCase()} link ${linkId} ('${entry.name}') as ${recordId}`);
    return { accepted: true, recordId };
  }

  private async resolve<K extends VocabularyKind>(
    adapter: VocabularyAdapter<K>,
    gatewayId: string,
    entry: EntryOf<K>,
    origin: VocabularyLinkOrigin,
    review: () => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<Resolution> {
    const existing = await adapter.findLink(this.db, gatewayId, entry.externalId);
    if (existing) {
      return { outcome: 'kept', recordId: recordOf(existing) };
    }

    const slug = toSlug(entry.name);
    const matched = await this.match(adapter, slug, entry.name);
    if (matched) {
      const link = await this.link(
        adapter,
        gatewayId,
        entry,
        { status: VocabularyLinkStatus.Resolved, recordId: matched, origin },
        signal,
      );
      return { outcome: 'matched', recordId: recordOf(link) };
    }

    if (await review()) {
      const link = await this.link(
        adapter,
        gatewayId,
        entry,
        { status: VocabularyLinkStatus.Pending, recordId: null, origin },
        signal,
      );
      return { outcome: 'pending', recordId: recordOf(link) };
    }

    const created = await this.createWithLink(adapter, gatewayId, entry, slug, origin, signal);
    return { outcome: 'created', recordId: recordOf(created) };
  }

  /** A record of the same slug or, unless the vocabulary matches by slug only, a similar name. */
  private async match<K extends VocabularyKind>(
    adapter: VocabularyAdapter<K>,
    slug: string,
    name: string,
  ): Promise<string | undefined> {
    const bySlug = await adapter.findBySlug(this.db, slug);
    if (bySlug || !adapter.similarityTable) {
      return bySlug;
    }

    const similar = await this.findSimilar(adapter.similarityTable, name);
    if (similar) {
      this.logger.debug(`${adapter.label} matched by a similar name: '${name}' → id=${similar}`);
    }

    return similar;
  }

  /** Writes the link unless one exists, and answers with the link as it stands. */
  private async link<K extends VocabularyKind>(
    adapter: VocabularyAdapter<K>,
    gatewayId: string,
    entry: EntryOf<K>,
    write: LinkWrite,
    signal?: AbortSignal,
  ): Promise<LinkResolution> {
    // The reads before it were a wait in which the section may have been abandoned.
    signal?.throwIfAborted();

    try {
      return await adapter.upsertLink(this.db, gatewayId, entry, write);
    } catch (error) {
      // A create-only upsert can still lose a race to a concurrent insert.
      const settled = isPrismaUniqueConstraintError(error)
        ? await adapter.findLink(this.db, gatewayId, entry.externalId)
        : null;
      if (settled) {
        return settled;
      }

      throw error;
    }
  }

  /**
   * Creates the record with its link. When another writer won a race, links
   * to the record it made under the slug, or answers with the link it made.
   */
  private async createWithLink<K extends VocabularyKind>(
    adapter: VocabularyAdapter<K>,
    gatewayId: string,
    entry: EntryOf<K>,
    slug: string,
    origin: VocabularyLinkOrigin,
    signal?: AbortSignal,
  ): Promise<LinkResolution> {
    signal?.throwIfAborted();

    try {
      const recordId = await adapter.createWithLink(this.db, gatewayId, entry, slug, origin);
      return { status: VocabularyLinkStatus.Resolved, recordId };
    } catch (error) {
      if (!isPrismaUniqueConstraintError(error)) {
        throw error;
      }

      const winner = await adapter.findBySlug(this.db, slug);
      if (winner) {
        return this.link(
          adapter,
          gatewayId,
          entry,
          { status: VocabularyLinkStatus.Resolved, recordId: winner, origin },
          signal,
        );
      }

      const link = await adapter.findLink(this.db, gatewayId, entry.externalId);
      if (link) {
        return link;
      }

      throw error;
    }
  }

  /** Creates a record alone, or finds the one another writer created under its slug first. */
  private async createRecord<K extends ReviewedVocabularyKind>(
    adapter: ReviewedVocabularyAdapter<K>,
    entry: EntryOf<K>,
    slug: string,
  ): Promise<string> {
    try {
      return await adapter.createRecord(this.db, entry, slug);
    } catch (error) {
      const winner = isPrismaUniqueConstraintError(error) ? await adapter.findBySlug(this.db, slug) : undefined;
      if (winner) {
        return winner;
      }

      throw error;
    }
  }

  private async findSimilar(table: Prisma.Sql, name: string): Promise<string | undefined> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM ${table}
      WHERE similarity(name, ${name}) > 0.85
        AND frozen_at IS NULL
      ORDER BY similarity(name, ${name}) DESC
      LIMIT 1
    `);
    return rows[0]?.id;
  }

  private async reviewRequired(adapter: Pick<VocabularyAdapter<VocabularyKind>, 'reviewSetting'>): Promise<boolean> {
    if (!adapter.reviewSetting) {
      return false;
    }

    const settings = await this.db.systemSetting.findFirst({
      where: { singleton: true },
      select: { reviewGatewayPlatforms: true, reviewGatewayCategories: true, reviewGatewayMechanics: true },
    });

    return settings?.[adapter.reviewSetting] ?? false;
  }
}
