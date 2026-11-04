import { AUTH_BASE_PATH } from '../constants';

/** The app sign-in routes, as better-auth names its endpoint paths: under `/api/auth` (#1019). */
export const APP_SIGN_IN_PATHS = {
  start: '/app-sign-in/start',
  return: '/app-sign-in/return',
  token: '/app-sign-in/token',
} as const;

/**
 * A flow's return page, as the start route gives it to better-auth for every
 * address the callback may send the browser to (#1019). Relative, as
 * better-auth's callback then sends it.
 */
export const appSignInReturnPage = (flowId: string): string =>
  `${AUTH_BASE_PATH}${APP_SIGN_IN_PATHS.return}?flow=${flowId}`;
