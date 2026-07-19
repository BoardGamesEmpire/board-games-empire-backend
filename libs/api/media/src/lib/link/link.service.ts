import { Action, DatabaseService, Prisma, ResourceType, isPrismaForeignKeyConstraintError } from '@bge/database';
import { t } from '@bge/i18n';
import type { ModelResourceType } from '@bge/permissions';
import { AbilityService } from '@bge/permissions';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { linkKey, mediaKindForMime } from '../constants/media-link.constants';
import { type AttachContext, LINK_HANDLERS } from './link.registry';

export interface AttachTarget {
  subjectType: ModelResourceType;
  subjectId: string;
  context?: AttachContext;
  presentation?: { title?: string; caption?: string; altText?: string; thumbnailUrl?: string };
}

export interface LinkResult {
  mediaId: string;
  attachmentId: string;
  subjectType: ModelResourceType;
  subjectId: string;
}

@Injectable()
export class MediaLinkService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ability: AbilityService,
  ) {}

  /** True if a media of this mime can attach to this subject (used to reject
   *  un-approvable contributions up front). */
  canLink(mimeType: string, subjectType: ModelResourceType): boolean {
    const kind = mediaKindForMime(mimeType);
    return kind !== null && LINK_HANDLERS[linkKey(subjectType, kind)] !== undefined;
  }

  /** Endpoint path: enforces the caller can update the specific object, then attaches. */
  async attach(mediaObjectId: string, target: AttachTarget): Promise<LinkResult> {
    const accessible = await this.db.mediaObject.findUnique({
      where: {
        id: mediaObjectId,
        AND: this.ability.getCurrentResourceConditions(ResourceType.MediaObject, Action.update),
      },
      select: { id: true },
    });
    if (!accessible) {
      throw new NotFoundException(t('errors.media_object.not_found', { id: mediaObjectId }));
    }

    await this.assertSubjectReadable(target.subjectType, target.subjectId);
    return this.db.$transaction((tx) => this.attachWithin(tx, mediaObjectId, target));
  }

  /**
   * Access-neutral primitive. Ensures the presentation Media row exists, then
   * dispatches to the right join table. Runs inside a caller-supplied transaction
   * so the contribution-approval flip + link commit atomically.
   */
  async attachWithin(tx: Prisma.TransactionClient, mediaObjectId: string, target: AttachTarget): Promise<LinkResult> {
    const media = await tx.mediaObject.findUnique({ where: { id: mediaObjectId }, select: { mimeType: true } });
    if (!media) {
      throw new NotFoundException(t('errors.media_object.not_found', { id: mediaObjectId }));
    }

    const kind = mediaKindForMime(media.mimeType);
    if (!kind) {
      throw new BadRequestException(t('errors.media_link.not_linkable', { mimeType: media.mimeType }));
    }

    const handler = LINK_HANDLERS[linkKey(target.subjectType, kind)];
    if (!handler) {
      throw new BadRequestException(t('errors.media_link.cannot_attach_kind', { kind, subjectType: target.subjectType }));
    }

    const presentation = target.presentation ?? {};
    const mediaRow = await tx.media.upsert({
      where: { mediaObjectId },
      create: {
        mediaObjectId,
        title: presentation.title ?? null,
        caption: presentation.caption ?? null,
        altText: presentation.altText ?? null,
        thumbnailUrl: presentation.thumbnailUrl ?? null,
      },
      update: {}, // presentation is set on first attach; editing is a separate concern
      select: { id: true },
    });

    try {
      const attachment = await handler.create(tx, mediaRow.id, target.subjectId, target.context ?? {});
      return {
        mediaId: mediaRow.id,
        attachmentId: attachment.id,
        subjectType: target.subjectType,
        subjectId: target.subjectId,
      };
    } catch (error) {
      if (isPrismaForeignKeyConstraintError(error)) {
        throw new NotFoundException(t('errors.media_link.subject_not_found', { subjectType: target.subjectType, subjectId: target.subjectId }));
      }
      throw error;
    }
  }

  async detach(
    mediaObjectId: string,
    target: { subjectType: ModelResourceType; subjectId: string },
  ): Promise<{ removed: number }> {
    const media = await this.db.mediaObject.findUnique({
      where: {
        id: mediaObjectId,
        AND: this.ability.getCurrentResourceConditions(ResourceType.MediaObject, Action.update),
      },
      select: { mimeType: true, media: { select: { id: true } } },
    });
    if (!media) {
      throw new NotFoundException(t('errors.media_object.not_found', { id: mediaObjectId }));
    }

    if (!media.media) {
      return { removed: 0 }; // never attached
    }

    const kind = mediaKindForMime(media.mimeType);
    const handler = kind ? LINK_HANDLERS[linkKey(target.subjectType, kind)] : undefined;
    if (!handler) {
      throw new BadRequestException(t('errors.media_link.cannot_detach_type', { subjectType: target.subjectType }));
    }

    await this.assertSubjectReadable(target.subjectType, target.subjectId);
    return { removed: await handler.remove(this.db, media.media.id, target.subjectId) };
  }

  /**
   * Endpoint-path guard: the caller must be able to *read* the target subject.
   * Read is the bar for attaching media — games are public, events are
   * attendee-private, so "can see it" cleanly means "can contribute media to
   * it" (a spectator at a competitive event can post photos). Not applied in
   * attachWithin: contribution approval carries its own authority.
   */
  private async assertSubjectReadable(subjectType: ResourceType, subjectId: string): Promise<void> {
    const AND = this.ability.getCurrentResourceConditions(subjectType as ModelResourceType, Action.read);

    let found: { id: string } | null;
    if (subjectType === ResourceType.Game) {
      found = await this.db.game.findUnique({ where: { id: subjectId, AND }, select: { id: true } });
    } else if (subjectType === ResourceType.Event) {
      found = await this.db.event.findUnique({ where: { id: subjectId, AND }, select: { id: true } });
    } else {
      throw new BadRequestException(t('errors.media_link.cannot_link_subject', { subjectType }));
    }

    if (!found) {
      throw new ForbiddenException(t('errors.media_link.forbidden_attach', { subjectType, subjectId }));
    }
  }
}
