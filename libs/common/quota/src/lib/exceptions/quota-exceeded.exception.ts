import type { QuotaScope } from '@bge/database';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { QuotaResource } from '../constants/quota-resource';

/**
 * Thrown by a write path when `QuotaService.check(...)` returns `allowed:
 * false`. Carries the binding constraint so the client knows which cap blocked
 * and by how much. Bigints are serialized as strings in the response body.
 *
 * 402 Payment Required is the closest standard code for an operational cap; it
 * does not imply billing here (the primitive is billing-agnostic).
 */
export class QuotaExceededException extends HttpException {
  constructor(
    public readonly resource: QuotaResource,
    public readonly scope: QuotaScope,
    public readonly limit: bigint,
    public readonly currentUsage: bigint,
    public readonly attemptedAmount: bigint,
  ) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'Quota Exceeded',
        message: `Quota for "${resource}" exceeded at ${scope} scope`,
        resource,
        scope,
        limit: limit.toString(),
        currentUsage: currentUsage.toString(),
        attemptedAmount: attemptedAmount.toString(),
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
