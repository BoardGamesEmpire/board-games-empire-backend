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

/** A removal's date, reason and note describe a removal, so a copy still owned has none to edit (#1231). */
export function copyStillOwned(): CodedHttpException {
  return new CodedHttpException(Http.Conflict, 'COLLECTION_COPY_OWNED', t('errors.game_collection.copy_owned'));
}

/** A condition describes a physical object, so a digital copy has none (#1231). */
export function conditionOnDigital(): CodedHttpException {
  return new CodedHttpException(
    Http.BadRequest,
    'COLLECTION_CONDITION_DIGITAL',
    t('errors.game_collection.condition_digital'),
  );
}

/** A copy's acquisition or removal is dated on a day that has not come yet (#1231). */
export function dateInFuture(): CodedHttpException {
  return new CodedHttpException(
    Http.BadRequest,
    'COLLECTION_DATE_IN_FUTURE',
    t('errors.game_collection.date_in_future'),
  );
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
