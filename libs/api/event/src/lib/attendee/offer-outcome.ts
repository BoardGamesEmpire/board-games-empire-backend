import type { I18nMessage } from '@bge/i18n';
import { t } from '@bge/i18n';
import type { OfferedGame } from '../offered-game/offered-game.types';

/**
 * Why a collection entry wasn't offered (#1188): a stable code a client can
 * branch on, beside a translated message. The values are the API's own, so
 * they don't move when a catalog key does.
 */
export const OfferRefusal = {
  /** No collection entry has this id. */
  NotFound: 'notFound',
  /** The attendee was added by name, so has no collection to offer from (#1210). */
  AttendeeHasNoCollection: 'attendeeHasNoCollection',
  /** The entry is in someone else's collection. */
  NotInAttendeesCollection: 'notInAttendeesCollection',
  /** The entry was removed from the collection: a game the attendee no longer owns. */
  RemovedFromCollection: 'removedFromCollection',
  /** Named as an expansion, but its game isn't an expansion of its item's game. */
  NotAnExpansionOfBase: 'notAnExpansionOfBase',
  /**
   * Named as an expansion of a game it's linked to, but its collection entry
   * is on a different platform from that game's (#1391).
   */
  DifferentPlatform: 'differentPlatform',
  /** Named as an expansion of a game that was refused. */
  BaseRefused: 'baseRefused',
} as const;

export type OfferRefusal = (typeof OfferRefusal)[keyof typeof OfferRefusal];

/** Every {@link OfferRefusal}, for the OpenAPI enum. */
export const OFFER_REFUSALS: readonly OfferRefusal[] = Object.values(OfferRefusal);

/**
 * What happened to one collection entry of a batch offer (#1188): `added`
 * (new, or taken back earlier and offered again), `alreadyOffered`,
 * each with the offered entry, or `refused`, with its reason and a message
 * the response translates.
 */
export type OfferResult =
  | { collectionId: string; entry: OfferedGame; outcome: 'added' | 'alreadyOffered' }
  | { collectionId: string; message: I18nMessage; outcome: 'refused'; reason: OfferRefusal };

/**
 * The message for `reason`, naming `collectionId` where the message does. It
 * is translated at the edge, in the caller's language, as every message is.
 */
export function offerRefusalMessage(reason: OfferRefusal, collectionId: string): I18nMessage {
  switch (reason) {
    case OfferRefusal.NotFound:
      return t('errors.attendee.game_collection_entry_not_found', { collectionId });
    case OfferRefusal.AttendeeHasNoCollection:
      return t('errors.attendee.attendee_has_no_collection');
    case OfferRefusal.NotInAttendeesCollection:
      return t('errors.attendee.game_from_other_collection');
    case OfferRefusal.RemovedFromCollection:
      return t('errors.attendee.game_removed_from_collection');
    case OfferRefusal.NotAnExpansionOfBase:
      return t('errors.attendee.not_an_expansion_of_base');
    case OfferRefusal.DifferentPlatform:
      return t('errors.attendee.different_platform');
    case OfferRefusal.BaseRefused:
      return t('errors.attendee.base_refused');
  }
}
