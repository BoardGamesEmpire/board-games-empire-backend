import type { UpstreamFetch, UpstreamRequest } from '@boardgamesempire/gateway-driver-contract';

/** A request a driver made through a {@link FakeFetch}. */
export interface FakeFetchRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** What a {@link FakeFetch} answers: 200 OK with an empty body unless it says otherwise. */
export interface FakeFetchReply {
  status?: number;
  statusText?: string;
  body?: string;
  headers?: Record<string, string>;
}

/** An {@link UpstreamFetch} for tests, which records every request a driver makes. */
export type FakeFetch = UpstreamFetch & { readonly requests: FakeFetchRequest[] };

const abortError = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');

/**
 * An {@link UpstreamFetch} that answers each request with what `respond`
 * gives, and records the request first. It rejects with an `AbortError` once
 * the request's signal aborts, as `fetch` does, even while `respond` is still
 * working, so a test can check that a driver stops a call it no longer wants
 * (#1082).
 */
export function createFakeFetch(
  respond: (request: FakeFetchRequest) => FakeFetchReply | Promise<FakeFetchReply>,
): FakeFetch {
  const requests: FakeFetchRequest[] = [];

  const fetch = async (url: string, init: UpstreamRequest): Promise<Response> => {
    const request: FakeFetchRequest = {
      url: new URL(url),
      method: init.method,
      headers: { ...init.headers },
      body: init.body,
      signal: init.signal,
    };
    requests.push(request);

    const { signal } = init;

    if (signal?.aborted) {
      throw abortError();
    }

    let stopListening = (): void => undefined;

    try {
      const reply = await new Promise<FakeFetchReply>((resolve, reject) => {
        const abort = () => reject(abortError());
        signal?.addEventListener('abort', abort, { once: true });
        stopListening = () => signal?.removeEventListener('abort', abort);

        Promise.resolve(respond(request)).then(resolve, reject);
      });

      return new Response(reply.body ?? null, {
        status: reply.status ?? 200,
        statusText: reply.statusText ?? 'OK',
        headers: reply.headers,
      });
    } finally {
      stopListening();
    }
  };

  return Object.assign(fetch, { requests });
}

/** A reply that never comes, for a test that aborts the request waiting on it. */
export const neverReply = (): Promise<FakeFetchReply> => new Promise<FakeFetchReply>(() => undefined);
