import { Prisma, ResourceType } from '@bge/database';
import { linkKey } from '../constants/media-link.constants';

/** Per-attachment context. Each handler reads the subset its join table supports. */
export interface AttachContext {
  isDefault?: boolean;
  isCover?: boolean;
  isFeatured?: boolean;
  sortOrder?: number;
  takenAt?: Date;
  category?: string;
}

interface LinkHandler {
  create(tx: Prisma.TransactionClient, mediaId: string, subjectId: string, ctx: AttachContext): Promise<{ id: string }>;
  remove(tx: Prisma.TransactionClient, mediaId: string, subjectId: string): Promise<number>;
}

/** (subjectType, kind) → join-table operations. Deny-by-default: an absent key
 *  means "not linkable", surfaced as a 400. Adding a subject/kind is one entry. */
export const LINK_HANDLERS: Readonly<Record<string, LinkHandler>> = {
  [linkKey(ResourceType.Game, 'image')]: {
    create: (tx, mediaId, gameId, ctx) =>
      tx.gameImage.upsert({
        where: { gameId_mediaId: { gameId, mediaId } },
        create: {
          mediaId,
          gameId,
          isDefault: ctx.isDefault ?? false,
          isCover: ctx.isCover ?? false,
          sortOrder: ctx.sortOrder ?? 0,
        },
        update: {
          ...(ctx.isDefault !== undefined && { isDefault: ctx.isDefault }),
          ...(ctx.isCover !== undefined && { isCover: ctx.isCover }),
          ...(ctx.sortOrder !== undefined && { sortOrder: ctx.sortOrder }),
        },
        select: { id: true },
      }),
    remove: (tx, mediaId, gameId) => tx.gameImage.deleteMany({ where: { mediaId, gameId } }).then((r) => r.count),
  },
  [linkKey(ResourceType.Game, 'document')]: {
    create: (tx, mediaId, gameId, ctx) =>
      tx.gameDocument.upsert({
        where: { gameId_mediaId: { gameId, mediaId } },
        create: { mediaId, gameId, category: ctx.category ?? null },
        update: { ...(ctx.category !== undefined && { category: ctx.category }) },
        select: { id: true },
      }),
    remove: (tx, mediaId, gameId) => tx.gameDocument.deleteMany({ where: { mediaId, gameId } }).then((r) => r.count),
  },
  [linkKey(ResourceType.Event, 'image')]: {
    create: (tx, mediaId, eventId, ctx) =>
      tx.eventImage.upsert({
        where: { eventId_mediaId: { eventId, mediaId } },
        create: { mediaId, eventId, isFeatured: ctx.isFeatured ?? false, takenAt: ctx.takenAt ?? null },
        update: {
          ...(ctx.isFeatured !== undefined && { isFeatured: ctx.isFeatured }),
          ...(ctx.takenAt !== undefined && { takenAt: ctx.takenAt }),
        },
        select: { id: true },
      }),
    remove: (tx, mediaId, eventId) => tx.eventImage.deleteMany({ where: { mediaId, eventId } }).then((r) => r.count),
  },
  [linkKey(ResourceType.Event, 'document')]: {
    create: (tx, mediaId, eventId, ctx) =>
      tx.eventDocument.upsert({
        where: { eventId_mediaId: { eventId, mediaId } },
        create: { mediaId, eventId, category: ctx.category ?? null },
        update: { ...(ctx.category !== undefined && { category: ctx.category }) },
        select: { id: true },
      }),
    remove: (tx, mediaId, eventId) => tx.eventDocument.deleteMany({ where: { mediaId, eventId } }).then((r) => r.count),
  },
};
