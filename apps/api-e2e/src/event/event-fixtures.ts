import { Visibility, type PrismaClient } from '@bge/database';
import { arrangeCollectionEntry } from '../game-collection/game-collection-fixtures';

/**
 * A game-list entry for `ownerId`'s attendee row on `eventId`: a fresh game in
 * the owner's collection, put on their list for the event. The owner must
 * already attend the event. List entries grant nothing, so arranging them
 * after the actors' first requests is safe.
 *
 * The collection entry is the game-collection suites' own fixture, kept at the
 * schema's default visibility, so a change to how a collection entry is
 * arranged lands in one place.
 *
 * The result is exactly a direct-add body's two required fields, so a spec can
 * send it as is.
 *
 * Extracted when a second suite needed it (#558), on the concrete-first rule
 * `../support/wire.ts` describes.
 */
export async function arrangeListEntry(
  prisma: PrismaClient,
  eventId: string,
  ownerId: string,
): Promise<{ platformGameId: string; suppliedById: string }> {
  const collectionId = await arrangeCollectionEntry(prisma, ownerId, Visibility.Private);
  const { platformGameId } = await prisma.gameCollection.findUniqueOrThrow({
    where: { id: collectionId },
    select: { platformGameId: true },
  });
  const attendee = await prisma.eventAttendee.findUniqueOrThrow({
    where: { eventId_userId: { eventId, userId: ownerId } },
    select: { id: true },
  });
  const entry = await prisma.eventAttendeeGameList.create({
    data: { attendeeId: attendee.id, collectionId },
    select: { id: true },
  });

  return { platformGameId, suppliedById: entry.id };
}
