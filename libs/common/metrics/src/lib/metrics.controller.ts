import { NoCache } from '@bge/shared';
import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { PrometheusController } from '@willsoto/nestjs-prometheus';

/**
 * Exempt from rate limiting. A scrape endpoint that returns 429 does not
 * degrade gracefully — it produces a gap in the series that reads as an outage,
 * and it does so precisely when something is scraping hard enough to matter.
 * The global throttler is IP-tracked, so several scrapers (or one scraper plus
 * a federation pull) behind a single address share one bucket.
 *
 * Access control for this endpoint is a separate question from rate limiting
 * and is not addressed here: it is `@AllowAnonymous` today.
 */
@SkipThrottle()
// Never response-cached: every scrape is the same anonymous caller, so a cached
// body would hand each scrape within the TTL the same frozen counters. A hit
// also skips the handler, which is what sets the exposition Content-Type (#528).
@NoCache()
@ApiTags('metrics')
@Controller('metrics')
@AllowAnonymous()
export class MetricsController extends PrometheusController {}
