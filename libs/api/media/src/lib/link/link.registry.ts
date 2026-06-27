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
    create: async (tx, mediaId, gameId, ctx) => {
      const existing = await tx.gameImage.findFirst({ where: { mediaId, gameId }, select: { id: true } });
      return (
        existing ??
        tx.gameImage.create({
          data: {
            mediaId,
            gameId,
            isDefault: ctx.isDefault ?? false,
            isCover: ctx.isCover ?? false,
            sortOrder: ctx.sortOrder ?? 0,
          },
          select: { id: true },
        })
      );
    },
    remove: (tx, mediaId, gameId) => tx.gameImage.deleteMany({ where: { mediaId, gameId } }).then((r) => r.count),
  },
  [linkKey(ResourceType.Game, 'document')]: {
    create: async (tx, mediaId, gameId, ctx) => {
      const existing = await tx.gameDocument.findFirst({
        where: { mediaId, gameId, category: ctx.category ?? null },
        select: { id: true },
      });
      return (
        existing ??
        tx.gameDocument.create({ data: { mediaId, gameId, category: ctx.category ?? null }, select: { id: true } })
      );
    },
    remove: (tx, mediaId, gameId) => tx.gameDocument.deleteMany({ where: { mediaId, gameId } }).then((r) => r.count),
  },
  [linkKey(ResourceType.Event, 'image')]: {
    create: async (tx, mediaId, eventId, ctx) => {
      const existing = await tx.eventImage.findFirst({ where: { mediaId, eventId }, select: { id: true } });
      return (
        existing ??
        tx.eventImage.create({
          data: { mediaId, eventId, isFeatured: ctx.isFeatured ?? false, takenAt: ctx.takenAt ?? null },
          select: { id: true },
        })
      );
    },
    remove: (tx, mediaId, eventId) => tx.eventImage.deleteMany({ where: { mediaId, eventId } }).then((r) => r.count),
  },
  [linkKey(ResourceType.Event, 'document')]: {
    create: async (tx, mediaId, eventId, ctx) => {
      const existing = await tx.eventDocument.findFirst({
        where: { mediaId, eventId, category: ctx.category ?? null },
        select: { id: true },
      });
      return (
        existing ??
        tx.eventDocument.create({ data: { mediaId, eventId, category: ctx.category ?? null }, select: { id: true } })
      );
    },
    remove: (tx, mediaId, eventId) => tx.eventDocument.deleteMany({ where: { mediaId, eventId } }).then((r) => r.count),
  },
};
