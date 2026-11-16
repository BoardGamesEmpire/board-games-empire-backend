/**
 * The COUNT every keyspace SCAN in BGE sends: a hint to the Redis-compatible
 * server, not a bound. In `RedisKeyFlush`, each page of matches is one UNLINK.
 *
 * Under 100 on purpose (#462). KeyDB 6.3 serves a SCAN of COUNT 100 or more
 * asynchronously and holds any command sent behind it on the same connection
 * until that connection sends again. The scan stream sends its next SCAN while
 * a page's UNLINK is on its way, so after the last SCAN that UNLINK, or another
 * request's command on the shared cache client, would wait forever. A page is
 * only a hint, so every Redis-compatible server returns the same keys; more
 * round trips is the cost (about 0.35 s more per flush of a 100k-key cache).
 *
 * A SCAN awaited before anything else is sent on its connection is not held,
 * but every SCAN uses this one value anyway, so no call site has to be reasoned
 * about on its own.
 *
 * Its own module, with no imports, and the `@bge/redis/scan-page` subpath, so
 * the e2e harness's global setup can read it without loading the rest of the
 * lib.
 */
export const SCAN_PAGE = 99;
