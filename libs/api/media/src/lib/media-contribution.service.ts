import {
  Action,
  ContributionOrigin,
  DatabaseService,
  MediaContributionStatus,
  ResourceType,
  Visibility,
} from '@bge/database';
import { AbilityService } from '@bge/permissions';
import { ServiceAccountService } from '@bge/services';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MediaContributionEvents } from './constants/media-contribution-events.constant';
import { ContributeMediaDto, ListContributionsQueryDto, RejectContributionDto } from './dto';
import type { MediaContributionRejectedEvent } from './interfaces/media-contribution.interface';

@Injectable()
export class MediaContributionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ability: AbilityService,
    private readonly serviceAccount: ServiceAccountService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Contribute media the caller owns to a subject. With approval disabled the
   * ownership flip happens immediately; with it enabled the contribution is
   * Pending until a moderator approves. Subject join rows are NOT created yet
   * (deferred linkage batch) — the intended target is recorded on the record.
   */
  async contribute(mediaObjectId: string, dto: ContributeMediaDto) {
    const actorId = this.ability.getActingUserId();

    const media = await this.db.mediaObject.findUnique({
      where: {
        id: mediaObjectId,
        AND: this.ability.getCurrentResourceConditions(ResourceType.MediaObject, Action.update),
      },
    });
    if (!media) {
      throw new NotFoundException(`Media object ${mediaObjectId} not found`);
    }

    if (media.ownerId !== actorId) {
      throw new ForbiddenException('You may only contribute media you own');
    }

    const existing = await this.db.mediaContribution.findFirst({
      where: { mediaObjectId, status: { in: [MediaContributionStatus.Pending, MediaContributionStatus.Approved] } },
      select: { id: true, status: true },
    });
    if (existing) {
      throw new ConflictException(`Media object ${mediaObjectId} already has a ${existing.status} contribution`);
    }

    const data = {
      mediaObjectId,
      subjectType: dto.subjectType,
      subjectId: dto.subjectId,
      category: dto.category ?? null,
      origin: ContributionOrigin.ExistingMedia, // DirectUpload comes from the future upload+contribute path
      contributedById: actorId,
    };

    if (await this.approvalRequired()) {
      return this.db.mediaContribution.create({ data: { ...data, status: MediaContributionStatus.Pending } });
    }

    const serviceAccountId = (await this.serviceAccount.resolve()).id;
    return this.db.$transaction(async (tx) => {
      const contribution = await tx.mediaContribution.create({
        data: { ...data, status: MediaContributionStatus.Approved, reviewedAt: new Date() },
      });
      await this.flipOwnership(tx, mediaObjectId, serviceAccountId);
      return contribution;
    });
  }

  async approve(contributionId: string) {
    const reviewerId = this.ability.getActingUserId();
    const contribution = await this.requirePending(contributionId);
    const serviceAccountId = (await this.serviceAccount.resolve()).id;

    return this.db.$transaction(async (tx) => {
      await this.flipOwnership(tx, contribution.mediaObjectId, serviceAccountId);
      return tx.mediaContribution.update({
        where: { id: contributionId },
        data: { status: MediaContributionStatus.Approved, reviewedById: reviewerId, reviewedAt: new Date() },
      });
    });
  }

  async reject(contributionId: string, dto: RejectContributionDto) {
    const reviewerId = this.ability.getActingUserId();
    const contribution = await this.requirePending(contributionId);

    // Only media uploaded *solely* to contribute is swept on reject; existing
    // media is left untouched (ownership was never flipped while Pending).
    const reclaimDeadline =
      contribution.origin === ContributionOrigin.DirectUpload
        ? new Date(Date.now() + (await this.reclaimDays()) * 24 * 60 * 60 * 1000)
        : null;

    const updated = await this.db.mediaContribution.update({
      where: { id: contributionId },
      data: {
        status: MediaContributionStatus.Rejected,
        rejectionReason: dto.reason ?? null,
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        reclaimDeadline,
      },
    });

    this.eventEmitter.emit(MediaContributionEvents.Rejected, {
      contributionId: updated.id,
      mediaObjectId: updated.mediaObjectId,
      contributedById: updated.contributedById,
      subjectType: updated.subjectType,
      subjectId: updated.subjectId,
      rejectionReason: updated.rejectionReason,
      reclaimDeadline: updated.reclaimDeadline?.toISOString() ?? null,
    } satisfies MediaContributionRejectedEvent);

    return updated;
  }

  async reclaim(contributionId: string) {
    const actorId = this.ability.getActingUserId();
    const contribution = await this.db.mediaContribution.findUnique({
      where: {
        id: contributionId,
        AND: this.ability.getCurrentResourceConditions(ResourceType.MediaContribution, Action.update),
      },
    });
    if (!contribution) {
      throw new NotFoundException(`Contribution ${contributionId} not found`);
    }
    if (contribution.contributedById !== actorId) {
      throw new ForbiddenException('You can only reclaim your own contribution');
    }
    if (contribution.status !== MediaContributionStatus.Rejected) {
      throw new ConflictException(`Only a rejected contribution can be reclaimed (status: ${contribution.status})`);
    }
    if (contribution.reclaimDeadline && contribution.reclaimDeadline.getTime() < Date.now()) {
      throw new ConflictException('The reclaim window has closed');
    }

    return this.db.mediaContribution.update({
      where: { id: contributionId },
      data: { status: MediaContributionStatus.Reclaimed },
    });
  }

  async list(query: ListContributionsQueryDto) {
    return this.db.mediaContribution.findMany({
      where: {
        AND: this.ability.getCurrentResourceConditions(ResourceType.MediaContribution, Action.read),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      skip: query.offset,
      take: query.limit || 20,
    });
  }

  private async flipOwnership(
    tx: Pick<DatabaseService, 'mediaObject'>,
    mediaObjectId: string,
    serviceAccountId: string,
  ): Promise<void> {
    // owner → service account (quota reattributes for free; usage sums by ownerId),
    // visibility → Public. uploaderId is left untouched: credit is permanent.
    await tx.mediaObject.update({
      where: { id: mediaObjectId },
      data: { ownerId: serviceAccountId, visibility: Visibility.Public },
    });
  }

  private async requirePending(contributionId: string) {
    const contribution = await this.db.mediaContribution.findUnique({
      where: {
        id: contributionId,
        AND: this.ability.getCurrentResourceConditions(ResourceType.MediaContribution, Action.update),
      },
    });
    if (!contribution) {
      throw new NotFoundException(`Contribution ${contributionId} not found`);
    }
    if (contribution.status !== MediaContributionStatus.Pending) {
      throw new ConflictException(`Contribution is not pending (status: ${contribution.status})`);
    }
    return contribution;
  }

  private async approvalRequired(): Promise<boolean> {
    const settings = await this.db.systemSetting.findFirst({ select: { requireContributionApproval: true } });
    return settings?.requireContributionApproval ?? false;
  }

  private async reclaimDays(): Promise<number> {
    const settings = await this.db.systemSetting.findFirst({ select: { contributionReclaimDays: true } });
    return settings?.contributionReclaimDays ?? 14;
  }
}
