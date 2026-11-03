import type { I18nPath } from '@bge/i18n';

/**
 * The stable codes an app sign-in refuses with (#1019), so the app can
 * announce or rephrase them. Each has a plain-language message in the message
 * catalog.
 */
export const APP_SIGN_IN_RETURN_ADDRESS_REFUSED = 'APP_SIGN_IN_RETURN_ADDRESS_REFUSED';
export const APP_SIGN_IN_REQUEST_INVALID = 'APP_SIGN_IN_REQUEST_INVALID';
export const APP_SIGN_IN_FLOW_INVALID = 'APP_SIGN_IN_FLOW_INVALID';
export const APP_SIGN_IN_CODE_INVALID = 'APP_SIGN_IN_CODE_INVALID';
export const APP_SIGN_IN_UNAVAILABLE = 'APP_SIGN_IN_UNAVAILABLE';

/**
 * better-auth's code for an unknown provider in a redirect
 * (`OAUTH_CALLBACK_ERROR_CODES.PROVIDER_NOT_FOUND`), which clients already
 * handle. better-auth doesn't export the constant, and sends no message with
 * it, so app sign-in sends its own.
 */
export const PROVIDER_NOT_FOUND = 'oauth_provider_not_found';

export type AppSignInErrorCode =
  | typeof APP_SIGN_IN_RETURN_ADDRESS_REFUSED
  | typeof APP_SIGN_IN_REQUEST_INVALID
  | typeof APP_SIGN_IN_FLOW_INVALID
  | typeof APP_SIGN_IN_CODE_INVALID
  | typeof APP_SIGN_IN_UNAVAILABLE
  | typeof PROVIDER_NOT_FOUND;

/** Each code's message, by its key in the message catalog. */
export const APP_SIGN_IN_MESSAGES: Readonly<Record<AppSignInErrorCode, I18nPath>> = {
  [APP_SIGN_IN_RETURN_ADDRESS_REFUSED]: 'errors.auth.app_sign_in_return_address_refused',
  [APP_SIGN_IN_REQUEST_INVALID]: 'errors.auth.app_sign_in_request_invalid',
  [APP_SIGN_IN_FLOW_INVALID]: 'errors.auth.app_sign_in_flow_invalid',
  [APP_SIGN_IN_CODE_INVALID]: 'errors.auth.app_sign_in_code_invalid',
  [APP_SIGN_IN_UNAVAILABLE]: 'errors.auth.app_sign_in_unavailable',
  [PROVIDER_NOT_FOUND]: 'errors.auth.app_sign_in_provider_not_found',
};
