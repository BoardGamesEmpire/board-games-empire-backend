import type { LanguageCodeFormat, LanguageLinkOrigin } from '@bge/database';
import { DatabaseService, LanguageLinkStatus, Prisma } from '@bge/database';
import { t } from '@bge/i18n';
import type { PaginatedRows } from '@bge/shared';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { LanguageLinkService } from './language-link.service';

export interface LanguageLinkTagView {
  id: string;
  tag: string;
  name: string;
}

/** A language link as the review routes return it (#715). */
export interface LanguageLinkView {
  id: string;
  gatewayId: string;
  value: string;
  format: LanguageCodeFormat;
  status: LanguageLinkStatus;
  origin: LanguageLinkOrigin;
  tag: LanguageLinkTagView | null;
  suppliedIetfTag: string | null;
  suppliedIso6393: string | null;
  suppliedIso6391: string | null;
  suppliedName: string | null;
  suppliedNativeName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The worklist an admin reviews: the links still waiting on a decision. */
export const DEFAULT_REVIEW_STATUSES: readonly LanguageLinkStatus[] = [
  LanguageLinkStatus.Pending,
  LanguageLinkStatus.Unresolved,
];

const LINK_VIEW_SELECT = {
  id: true,
  gatewayId: true,
  value: true,
  format: true,
  status: true,
  origin: true,
  tag: { select: { id: true, tag: true, name: true } },
  suppliedIetfTag: true,
  suppliedIso6393: true,
  suppliedIso6391: true,
  suppliedName: true,
  suppliedNativeName: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LanguageGatewayLinkSelect;

/**
 * Review of one DataGateway's language links (#715): the worklist, and an
 * admin's link, ignore and accept.
 *
 * Every call names the DataGateway, and a link is found only under its own.
 * A link id is unique across DataGateways, so without that a route scoped to
 * one DataGateway could settle another's link. Whether the DataGateway itself
 * exists is the caller's check: links carry no foreign key to it.
 */
@Injectable()
export class LanguageLinkReviewService {
  constructor(
    private readonly db: DatabaseService,
    private readonly links: LanguageLinkService,
  ) {}

  /**
   * One page of the DataGateway's links in the given statuses, by value. The
   * rows and the count come from one REPEATABLE READ snapshot, so `total`
   * agrees with the rows sent while an interview writes links.
   */
  async list(
    gatewayId: string,
    statuses: readonly LanguageLinkStatus[],
    paging: { skip: number; pageSize: number },
  ): Promise<PaginatedRows<LanguageLinkView>> {
    const where: Prisma.LanguageGatewayLinkWhereInput = { gatewayId, status: { in: [...statuses] } };

    const [rows, total] = await this.db.$transaction(
      [
        this.db.languageGatewayLink.findMany({
          where,
          // Values repeat across formats ('en' as a tag and as an ISO code),
          // so the id breaks the tie and keeps pages stable.
          orderBy: [{ value: 'asc' }, { id: 'asc' }],
          skip: paging.skip,
          take: paging.pageSize,
          select: LINK_VIEW_SELECT,
        }),
        this.db.languageGatewayLink.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows, total };
  }

  /** Links the link to a tag, whatever its status. */
  async link(gatewayId: string, linkId: string, tagId: string): Promise<LanguageLinkView> {
    await this.findOwned(gatewayId, linkId);

    const tag = await this.db.languageTag.findUnique({ where: { id: tagId }, select: { id: true } });
    if (!tag) {
      throw new BadRequestException(t('errors.language_link.tag_not_found', { tagId }));
    }

    return this.db.languageGatewayLink.update({
      where: { id: linkId, gatewayId },
      data: { status: LanguageLinkStatus.Resolved, tagId },
      select: LINK_VIEW_SELECT,
    });
  }

  /** Dismisses the link, whatever its status. An interview leaves an Ignored link alone. */
  async ignore(gatewayId: string, linkId: string): Promise<LanguageLinkView> {
    await this.findOwned(gatewayId, linkId);

    return this.db.languageGatewayLink.update({
      where: { id: linkId, gatewayId },
      data: { status: LanguageLinkStatus.Ignored, tagId: null },
      select: LINK_VIEW_SELECT,
    });
  }

  /** Accepts a Pending link, adding its language and tag when they're missing. */
  async accept(gatewayId: string, linkId: string): Promise<LanguageLinkView> {
    await this.findOwned(gatewayId, linkId);

    const outcome = await this.links.acceptPending(linkId);
    if (!outcome.accepted) {
      throw new ConflictException(t(`errors.language_link.${outcome.reason}`, { id: linkId }));
    }

    return this.findOwned(gatewayId, linkId);
  }

  private async findOwned(gatewayId: string, linkId: string): Promise<LanguageLinkView> {
    const link = await this.db.languageGatewayLink.findUnique({
      where: { id: linkId, gatewayId },
      select: LINK_VIEW_SELECT,
    });

    if (!link) {
      throw new NotFoundException(t('errors.language_link.not_found', { id: linkId }));
    }

    return link;
  }
}
