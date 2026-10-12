import { SetMetadata } from '@nestjs/common';

export const CACHE_RESPONSE_KEY = 'CACHE_RESPONSE';

/**
 * Opts a route into the api's response cache (#530). An unmarked route is
 * never cached.
 *
 * A cached response is replayed to the same caller, in the same locale, until
 * `CACHE_TTL` runs out, or a `@CacheTTL()` on the route or its controller. A
 * hit never reaches the handler, so it skips the service and the row checks
 * the service makes behind a type-level guard. Mark only a route whose
 * response may be that old for the caller it was cached for.
 *
 * It decorates a method, never a controller, so a GET added to a controller
 * later is not cached until someone decides it should be.
 */
export const CacheResponse = (): MethodDecorator => SetMetadata(CACHE_RESPONSE_KEY, true);
