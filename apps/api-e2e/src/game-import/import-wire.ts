import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription } from '../support/wire';

/**
 * Fail-loud parsers for the import status envelopes, on the pattern
 * `household/household-wire.ts` sets.
 */

/** The fields the assertions read. */
export interface ImportBatchWire {
  readonly batchId: string;
  readonly jobs: readonly { readonly jobId: string }[];
}

export interface ListBatchesEnvelope {
  readonly batches: readonly ImportBatchWire[];
  readonly total: number;
}

const fail = envelopeFailure('apps/api-e2e/src/game-import/import-wire.ts');

function asBatch(value: unknown): ImportBatchWire | undefined {
  if (!isRecord(value) || typeof value['batchId'] !== 'string') {
    return undefined;
  }

  const jobs = value['jobs'];
  if (!Array.isArray(jobs) || !jobs.every((job) => isRecord(job) && typeof job['jobId'] === 'string')) {
    return undefined;
  }

  return value as unknown as ImportBatchWire;
}

/** `GET /api/games/import`: `{ batches: [...], pagination }`. */
export function listBatchesEnvelope(response: HttpResponseLike, request: RequestDescription): ListBatchesEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const batches = response.body['batches'];
  if (!Array.isArray(batches)) {
    return fail("it carried no 'batches' array", request, response);
  }

  const rows: ImportBatchWire[] = [];
  for (const entry of batches) {
    const batch = asBatch(entry);
    if (batch === undefined) {
      return fail("one of its batches has no string 'batchId' or no 'jobs' array of ids", request, response);
    }

    rows.push(batch);
  }

  const pagination = response.body['pagination'];
  const total = isRecord(pagination) ? pagination['total'] : undefined;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < rows.length) {
    return fail("it carried no integer 'pagination.total' at least as large as its page", request, response);
  }

  return { batches: rows, total };
}

/** `GET /api/games/import/:batchId`: the batch itself, unwrapped. */
export function batchEnvelope(response: HttpResponseLike, request: RequestDescription): ImportBatchWire {
  return asBatch(response.body) ?? fail("it is not a batch with a string 'batchId' and 'jobs'", request, response);
}
