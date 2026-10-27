import type { DataGatewaySectionFailure } from '@bge/database';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A list job's section that failed (#718). Its section row records only
 * `code`, since the admin routes return it; the raw error is logged, and
 * kept here as the cause.
 */
export class VocabularySectionError extends Error {
  constructor(
    readonly code: DataGatewaySectionFailure,
    cause: unknown,
  ) {
    super(`The section failed (${code}): ${errorMessage(cause)}`, { cause });
    this.name = VocabularySectionError.name;
  }
}
