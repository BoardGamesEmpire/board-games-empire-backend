import { CodedHttpException, t } from '@bge/i18n';
import { Http } from '@status/codes';
import { API_KEY_EXPIRY_MAX_DAYS, API_KEY_EXPIRY_MIN_DAYS } from './api-key.constants';

/**
 * Only a signed-in user manages their API keys. A key can't create, edit or
 * delete keys, or list what its owner's keys may hold: a leaked key must not
 * mint a longer-lived or wider one (#1418).
 */
export function apiKeySessionRequired(): CodedHttpException {
  return new CodedHttpException(Http.Forbidden, 'API_KEY_SESSION_REQUIRED', t('errors.api_key.session_required'));
}

/** `/api/api-keys/current` describes the calling key, so only a key may call it (#1418). */
export function apiKeyRequired(): CodedHttpException {
  return new CodedHttpException(Http.Forbidden, 'API_KEY_REQUIRED', t('errors.api_key.key_required'));
}

/**
 * A missing key and another user's key get the same 404, so a caller can't
 * learn which ids exist (#1418).
 */
export function apiKeyNotFound(): CodedHttpException {
  return new CodedHttpException(Http.NotFound, 'API_KEY_NOT_FOUND', t('errors.api_key.not_found'));
}

/**
 * A requested key scope names a permission the owner's key may not hold: one
 * the catalog lacks, one on `all`, or one the owner doesn't hold where a key
 * scope over it would build (#1418). `slug` names it for a client.
 */
export function scopeNotGrantable(slug: string): CodedHttpException {
  return new CodedHttpException(
    Http.UnprocessableEntity,
    'API_KEY_SCOPE_NOT_GRANTABLE',
    t('errors.api_key.scope_not_grantable', { slug }),
    { fields: { slug } },
  );
}

/** A requested key scope pins a row on a permission that accepts no pin (#1418). `slug` names it for a client. */
export function scopeNotPinnable(slug: string): CodedHttpException {
  return new CodedHttpException(
    Http.UnprocessableEntity,
    'API_KEY_SCOPE_NOT_PINNABLE',
    t('errors.api_key.scope_not_pinnable', { slug }),
    { fields: { slug } },
  );
}

/** A request names both key scopes and the "everything I can do" preset, so neither is guessed at (#1418). */
export function scopesOrPreset(): CodedHttpException {
  return new CodedHttpException(
    Http.UnprocessableEntity,
    'API_KEY_SCOPES_OR_PRESET',
    t('errors.api_key.scopes_or_preset'),
  );
}

/** Giving a key a Critical permission it doesn't already hold needs the owner's explicit confirmation (#1418). */
export function criticalNeedsConfirmation(): CodedHttpException {
  return new CodedHttpException(
    Http.UnprocessableEntity,
    'API_KEY_CRITICAL_NEEDS_CONFIRMATION',
    t('errors.api_key.critical_needs_confirmation'),
  );
}

/**
 * Giving a key a Critical permission it doesn't already hold needs a recent
 * sign-in, by better-auth's fresh-session rule, so a session left open can't
 * mint one (#1418).
 */
export function needsRecentSignIn(): CodedHttpException {
  return new CodedHttpException(
    Http.Forbidden,
    'API_KEY_NEEDS_RECENT_SIGN_IN',
    t('errors.api_key.needs_recent_sign_in'),
  );
}

/** A key expires 1 to 365 days from now; `min` and `max` carry the range for a client (#1418). */
export function expiryOutOfRange(): CodedHttpException {
  const range = { min: API_KEY_EXPIRY_MIN_DAYS, max: API_KEY_EXPIRY_MAX_DAYS };

  return new CodedHttpException(
    Http.UnprocessableEntity,
    'API_KEY_EXPIRY_OUT_OF_RANGE',
    t('errors.api_key.expiry_out_of_range', range),
    { fields: range },
  );
}
