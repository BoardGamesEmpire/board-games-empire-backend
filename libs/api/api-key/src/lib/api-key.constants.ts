/**
 * A key's expiry is days from now, 1 to 365, with no "never": a key that leaks
 * stops working within a year whatever its owner does (#1418). better-auth's
 * own range is 1 to 365 days, so its refusals never fire for a valid request.
 */
export const API_KEY_EXPIRY_MIN_DAYS = 1;

export const API_KEY_EXPIRY_MAX_DAYS = 365;

/** The expiry a key gets when its create names none (#1418). */
export const API_KEY_EXPIRY_DEFAULT_DAYS = 90;

/** better-auth refuses a key name longer than this (#1418). */
export const API_KEY_NAME_MAX_LENGTH = 32;
