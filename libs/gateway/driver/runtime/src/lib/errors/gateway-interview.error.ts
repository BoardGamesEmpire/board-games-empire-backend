import type { DataGatewayInterviewFailure } from '@bge/database';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * An interview that failed. The row records only `failure`, a coarse code,
 * since the admin routes return the whole row; the raw error is logged, and
 * kept here as the cause.
 */
export class GatewayInterviewError extends Error {
  constructor(
    readonly gatewayId: string,
    readonly failure: DataGatewayInterviewFailure,
    cause: unknown,
  ) {
    super(`The interview of DataGateway ${gatewayId} failed (${failure}): ${errorMessage(cause)}`, { cause });
    this.name = GatewayInterviewError.name;
  }
}
