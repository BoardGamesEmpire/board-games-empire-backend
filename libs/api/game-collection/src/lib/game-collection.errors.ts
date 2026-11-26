import { CodedHttpException, t } from '@bge/i18n';
import { Http } from '@status/codes';

/**
 * The refusal for a collection entry the actor can't see: missing, already
 * removed, or outside their scope, which the 404 never tells apart. Its code
 * says the 404 is about this row, so a client may read it as "already removed"
 * and complete a queued removal, where a 404 without it (a route that moved,
 * an id that matched no route) may not (#634).
 */
export function collectionEntryNotFound(id: string): CodedHttpException {
  return new CodedHttpException(
    Http.NotFound,
    'COLLECTION_ENTRY_NOT_FOUND',
    t('errors.game_collection.not_found', { id }),
  );
}

/**
 * The refusal for a copy the route's entry doesn't hold: missing, on another
 * entry, or on an entry the actor can't write, which the 404 never tells
 * apart. Like `collectionEntryNotFound`, its code says the 404 is about this
 * row (#1231).
 */
export function copyNotFound(id: string): CodedHttpException {
  return new CodedHttpException(
    Http.NotFound,
    'COLLECTION_COPY_NOT_FOUND',
    t('errors.game_collection.copy_not_found', { id }),
  );
}

/**
 * The refusal for a revision the route's copy doesn't hold: missing, a
 * revision of another copy, or one whose stored values can't be read back,
 * which the 404 never tells apart. Like `copyNotFound`, its code says the 404
 * is about this row (#1231).
 */
export function revisionNotFound(id: string): CodedHttpException {
  return new CodedHttpException(
    Http.NotFound,
    'COLLECTION_REVISION_NOT_FOUND',
    t('errors.game_collection.revision_not_found', { id }),
  );
}

/**
 * An entry holds at most `max` copies, removed and taken-back ones included;
 * `limit` carries the number for a client, as a quota's does (#1231).
 */
export function copyLimitReached(max: number): CodedHttpException {
  return new CodedHttpException(
    Http.Conflict,
    'COLLECTION_COPY_LIMIT_REACHED',
    t('errors.game_collection.copy_limit_reached', { max }),
    { fields: { limit: max } },
  );
}

/** A removal's date and reason describe a removal, so a copy not removed has none to edit (#1231). */
export function copyNotRemoved(): CodedHttpException {
  return new CodedHttpException(
    Http.Conflict,
    'COLLECTION_COPY_NOT_REMOVED',
    t('errors.game_collection.copy_not_removed'),
  );
}

/** A condition describes a physical object, so a digital copy has none (#1231). */
export function conditionOnDigital(): CodedHttpException {
  return new CodedHttpException(
    Http.BadRequest,
    'COLLECTION_CONDITION_DIGITAL',
    t('errors.game_collection.condition_digital'),
  );
}

/** The dates of a copy a request may set, by their wire names (#1231). */
export type CopyDateField = 'acquiredOn' | 'removedOn';

/** What each copy date's refusal says, so a PATCH sending both names the one refused (#1231). */
const DATE_IN_FUTURE_MESSAGES = {
  acquiredOn: 'errors.game_collection.acquired_on_in_future',
  removedOn: 'errors.game_collection.removed_on_in_future',
} as const satisfies Record<CopyDateField, string>;

/**
 * A copy's acquisition or removal is dated on a day that has not come yet
 * anywhere on Earth (#1231). `field` names which date, in the message and in
 * the envelope's `field`, so a client can mark the right input.
 */
export function dateInFuture(field: CopyDateField): CodedHttpException {
  return new CodedHttpException(Http.BadRequest, 'COLLECTION_DATE_IN_FUTURE', t(DATE_IN_FUTURE_MESSAGES[field]), {
    fields: { field },
  });
}

/** A copy can't be removed before it was acquired (#1231). */
export function dateOrder(): CodedHttpException {
  return new CodedHttpException(Http.BadRequest, 'COLLECTION_DATE_ORDER', t('errors.game_collection.date_order'));
}

/** The price names a currency that ISO 4217 doesn't list; `code` is what the client sent (#1231). */
export function currencyUnknown(code: string): CodedHttpException {
  return new CodedHttpException(
    Http.BadRequest,
    'COLLECTION_CURRENCY_UNKNOWN',
    t('errors.game_collection.currency_unknown', { code }),
  );
}

/**
 * The platform game an add names is missing, read so or gone before the
 * entry's insert, under the code the list routes give the same row (#1231).
 */
export function platformGameNotFound(id: string): CodedHttpException {
  return new CodedHttpException(Http.NotFound, 'PLATFORM_GAME_NOT_FOUND', t('errors.platform_game.not_found', { id }));
}

/**
 * The release a copy names as its edition is missing, read so or gone before
 * the copy's write, under the code the list routes give the same row (#1231).
 */
export function releaseNotFound(id: string): CodedHttpException {
  return new CodedHttpException(Http.NotFound, 'GAME_RELEASE_NOT_FOUND', t('errors.game_release.not_found', { id }));
}

/** The release a copy names is a release of another platform game than its entry's (#1231). */
export function releasePlatformMismatch(releaseId: string, platformGameId: string): CodedHttpException {
  return new CodedHttpException(
    Http.BadRequest,
    'COLLECTION_RELEASE_PLATFORM_MISMATCH',
    t('errors.game_collection.release_platform_mismatch', { releaseId, platformGameId }),
  );
}
