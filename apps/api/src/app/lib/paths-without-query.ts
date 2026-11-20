import { STEAM_RETURN_PATH } from '@bge/upstream-account';

/**
 * Request paths whose query string reaches neither a log line nor a trace
 * span. The Steam sign-in's return carries the SteamID in its query, and
 * unlinking deletes the SteamID, so it must not stay behind in either (#935).
 */
export const PATHS_WITHOUT_QUERY: readonly string[] = [STEAM_RETURN_PATH];
