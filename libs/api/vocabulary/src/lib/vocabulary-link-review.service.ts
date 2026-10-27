import { DatabaseService, VocabularyLinkStatus } from '@bge/database';
import { t } from '@bge/i18n';
import type { PaginatedRows } from '@bge/shared';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { REVIEWED_ADAPTERS, type ReviewedVocabularyAdapter } from './vocabulary-adapters';
import { VocabularyLinkService } from './vocabulary-link.service';
import type { ReviewedVocabularyKind, VocabularyLinkView } from './vocabulary.types';

/** The worklist an admin reviews: the links still waiting on a decision. */
export const DEFAULT_VOCABULARY_REVIEW_STATUSES: readonly VocabularyLinkStatus[] = [VocabularyLinkStatus.Pending];

/**
 * Review of one DataGateway's platform, category or mechanic links (#715,
 * #718): the worklist, and an admin's link, ignore and accept, as the
 * language links have.
 *
 * Every call names the DataGateway, and a link is found only under its own.
 * A link id is unique across DataGateways, so without that a route scoped to
 * one DataGateway could settle another's link. Whether the DataGateway itself
 * exists is the caller's check: links carry no foreign key to it.
 */
@Injectable()
export class VocabularyLinkReviewService {
  constructor(
    private readonly db: DatabaseService,
    private readonly links: VocabularyLinkService,
  ) {}

  /**
   * One page of the DataGateway's links in the given statuses, by supplied
   * name. The rows and the count come from one REPEATABLE READ snapshot, so
   * `total` agrees with the rows sent while a list job writes links.
   */
  list(
    kind: ReviewedVocabularyKind,
    gatewayId: string,
    statuses: readonly VocabularyLinkStatus[],
    paging: { skip: number; pageSize: number },
  ): Promise<PaginatedRows<VocabularyLinkView>> {
    return this.adapter(kind).list(this.db, { gatewayId, statuses, ...paging });
  }

  /** Links the link to a record, whatever its status. */
  async link(
    kind: ReviewedVocabularyKind,
    gatewayId: string,
    linkId: string,
    recordId: string,
  ): Promise<VocabularyLinkView> {
    const adapter = this.adapter(kind);
    await this.findOwned(adapter, gatewayId, linkId);

    if (!(await adapter.recordExists(this.db, recordId))) {
      throw new BadRequestException(t('errors.vocabulary_link.record_not_found', { recordId }));
    }

    return adapter.decide(this.db, gatewayId, linkId, { status: VocabularyLinkStatus.Resolved, recordId });
  }

  /** Dismisses the link, whatever its status. Import leaves an Ignored link's entry out, and a list job keeps it. */
  async ignore(kind: ReviewedVocabularyKind, gatewayId: string, linkId: string): Promise<VocabularyLinkView> {
    const adapter = this.adapter(kind);
    await this.findOwned(adapter, gatewayId, linkId);

    return adapter.decide(this.db, gatewayId, linkId, { status: VocabularyLinkStatus.Ignored, recordId: null });
  }

  /** Accepts a Pending link, adding its record from what the DataGateway sent unless one matches. */
  async accept(kind: ReviewedVocabularyKind, gatewayId: string, linkId: string): Promise<VocabularyLinkView> {
    const adapter = this.adapter(kind);
    await this.findOwned(adapter, gatewayId, linkId);

    const outcome = await this.links.acceptPending(kind, linkId);
    if (!outcome.accepted) {
      throw new ConflictException(t(`errors.vocabulary_link.${outcome.reason}`, { id: linkId }));
    }

    return this.findOwned(adapter, gatewayId, linkId);
  }

  private adapter(kind: ReviewedVocabularyKind): ReviewedVocabularyAdapter<ReviewedVocabularyKind> {
    return REVIEWED_ADAPTERS[kind] as ReviewedVocabularyAdapter<ReviewedVocabularyKind>;
  }

  private async findOwned(
    adapter: ReviewedVocabularyAdapter<ReviewedVocabularyKind>,
    gatewayId: string,
    linkId: string,
  ): Promise<VocabularyLinkView> {
    const link = await adapter.findOwned(this.db, gatewayId, linkId);
    if (!link) {
      throw new NotFoundException(t('errors.vocabulary_link.not_found', { id: linkId }));
    }

    return link;
  }
}
