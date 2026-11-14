import { CodedHttpException, t } from '@bge/i18n';
import { Http } from '@status/codes';

/**
 * The refusal for a list the actor can't see or write: missing, or outside
 * their scope, which the 404 never tells apart (#1241). Its code says the 404
 * is about this row, so a client may read it as "already gone" (#634).
 */
export function listNotFound(id: string): CodedHttpException {
  return new CodedHttpException(Http.NotFound, 'LIST_NOT_FOUND', t('errors.list.not_found', { id }));
}

/** The wishlist is every user's own, so it is renamed or emptied, never deleted (#1241). */
export function wishlistUndeletable(): CodedHttpException {
  return new CodedHttpException(Http.Conflict, 'WISHLIST_UNDELETABLE', t('errors.list.wishlist_undeletable'));
}

/** A custom list has no name a client could show in its place. Only the wishlist may go without one (#1241). */
export function listNameRequired(): CodedHttpException {
  return new CodedHttpException(Http.BadRequest, 'LIST_NAME_REQUIRED', t('errors.list.name_required'));
}

/**
 * A reorder must name exactly the acting user's lists. One that doesn't was
 * built from a list of lists that has since changed, so the client reloads and
 * tries again (#1241).
 */
export function listOrderStale(): CodedHttpException {
  return new CodedHttpException(Http.Conflict, 'LIST_ORDER_STALE', t('errors.list.order_stale'));
}

/**
 * A list reorder renumbers every list the user holds, so it needs the right to
 * change every one. A caller who may change only some, such as an API key
 * pinned to one list, can't reorder them at all (#1241).
 */
export function listOrderForbidden(): CodedHttpException {
  return new CodedHttpException(Http.Forbidden, 'LIST_ORDER_FORBIDDEN', t('errors.list.order_forbidden'));
}

/** A user holds at most `max` lists; `limit` carries the number for a client (#1241). */
export function listLimitReached(max: number): CodedHttpException {
  return new CodedHttpException(Http.Conflict, 'LIST_LIMIT_REACHED', t('errors.list.limit_reached', { max }), {
    fields: { limit: max },
  });
}

/**
 * The refusal for a list entry that isn't on the list the route names:
 * missing, or on another list, which the 404 never tells apart (#1241). Like
 * `listNotFound`, its code says the 404 is about this row (#634).
 */
export function listEntryNotFound(id: string): CodedHttpException {
  return new CodedHttpException(Http.NotFound, 'LIST_ENTRY_NOT_FOUND', t('errors.list.entry_not_found', { id }));
}

/** An entry names a game on any platform or one platform game: exactly one of the two (#1241). */
export function listEntryOneTarget(): CodedHttpException {
  return new CodedHttpException(Http.BadRequest, 'LIST_ENTRY_ONE_TARGET', t('errors.list.entry_one_target'));
}

/** A game, or a platform game, is on a list once (#1241). */
export function listEntryExists(): CodedHttpException {
  return new CodedHttpException(Http.Conflict, 'LIST_ENTRY_EXISTS', t('errors.list.entry_exists'));
}

/**
 * A wishlist priority is about buying, so it means nothing on any other list,
 * which refuses one (#1241).
 */
export function listPriorityWishlistOnly(): CodedHttpException {
  return new CodedHttpException(
    Http.BadRequest,
    'LIST_PRIORITY_WISHLIST_ONLY',
    t('errors.list.priority_wishlist_only'),
  );
}

/** A release belongs to one platform game, so an entry naming a game on any platform can't carry one (#1241). */
export function listEntryReleaseNeedsPlatformGame(): CodedHttpException {
  return new CodedHttpException(
    Http.BadRequest,
    'LIST_ENTRY_RELEASE_NEEDS_PLATFORM_GAME',
    t('errors.list.entry_release_needs_platform_game'),
  );
}

/** The release named is another platform game's, not the entry's (#1241). */
export function listEntryReleaseMismatch(releaseId: string, platformGameId: string): CodedHttpException {
  return new CodedHttpException(
    Http.BadRequest,
    'LIST_ENTRY_RELEASE_MISMATCH',
    t('errors.list.entry_release_mismatch', { releaseId, platformGameId }),
  );
}

/** A list holds at most `max` entries; `limit` carries the number for a client (#1241). */
export function listFull(max: number): CodedHttpException {
  return new CodedHttpException(Http.Conflict, 'LIST_FULL', t('errors.list.full', { max }), {
    fields: { limit: max },
  });
}

/**
 * An entry reorder must name exactly the list's entries. It shares
 * `LIST_ORDER_STALE` with the list reorder, so a client handles both one way,
 * and says in its message that it was the entries that changed (#1241).
 */
export function listEntryOrderStale(): CodedHttpException {
  return new CodedHttpException(Http.Conflict, 'LIST_ORDER_STALE', t('errors.list.entry_order_stale'));
}

/** An update body that names no field to change (#1241). */
export function nothingToUpdate(): CodedHttpException {
  return new CodedHttpException(Http.BadRequest, 'NOTHING_TO_UPDATE', t('common.at_least_one_field'));
}

/**
 * The game an entry names is missing, or not the actor's to read, which the
 * 404 never tells apart (#1241).
 */
export function gameNotFound(id: string): CodedHttpException {
  return new CodedHttpException(Http.NotFound, 'GAME_NOT_FOUND', t('errors.game.not_found', { id }));
}

/**
 * The platform game an entry names is missing, or its game is not the actor's
 * to read, which the 404 never tells apart (#1241).
 */
export function platformGameNotFound(id: string): CodedHttpException {
  return new CodedHttpException(Http.NotFound, 'PLATFORM_GAME_NOT_FOUND', t('errors.platform_game.not_found', { id }));
}

/** The release an entry names doesn't exist (#1241). */
export function gameReleaseNotFound(id: string): CodedHttpException {
  return new CodedHttpException(Http.NotFound, 'GAME_RELEASE_NOT_FOUND', t('errors.game_release.not_found', { id }));
}
