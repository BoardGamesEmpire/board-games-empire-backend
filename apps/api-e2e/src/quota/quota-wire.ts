import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription } from '../support/wire';

/**
 * Fail-loud parsers for the quota list envelopes, on the pattern
 * `household/household-wire.ts` sets.
 */

/** The fields the assertions read. `limit` travels as a string (a BigInt column). */
export interface QuotaWire {
  readonly id: string;
  readonly scope: string;
  readonly scopeId: string | null;
  readonly householdId: string | null;
  readonly resource: string;
  readonly limit: string;
}

const fail = envelopeFailure('apps/api-e2e/src/quota/quota-wire.ts');

function asQuota(value: unknown): QuotaWire | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return typeof value['id'] === 'string' && typeof value['limit'] === 'string'
    ? (value as unknown as QuotaWire)
    : undefined;
}

/**
 * `GET /api/quotas` and `GET /api/households/:householdId/quotas`: a bare
 * `{ quotas: [...] }`, with no pagination envelope.
 */
export function quotasEnvelope(response: HttpResponseLike, request: RequestDescription): readonly QuotaWire[] {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const quotas = response.body['quotas'];
  if (!Array.isArray(quotas)) {
    return fail("it carried no 'quotas' array", request, response);
  }

  const rows: QuotaWire[] = [];
  for (const entry of quotas) {
    const row = asQuota(entry);
    if (row === undefined) {
      return fail("one of its quotas is not an object with a string id and 'limit'", request, response);
    }

    rows.push(row);
  }

  return rows;
}
