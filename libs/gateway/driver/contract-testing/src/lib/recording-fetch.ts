import type { UpstreamFetch } from '@boardgamesempire/gateway-driver-contract';

/** A request a recording fetch passed on, as its recorder sees it. */
export interface RecordedRequest {
  url: URL;
  method: string;
  body?: string;
}

/** Statuses whose answer has no body, which a Response refuses one for. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * An UpstreamFetch that asks the real upstream through `fetch`, Node's own
 * unless given another, and hands each successful answer to `record` with its
 * request, so a test can keep it as an upstream fixture (#1082). A driver's
 * parity spec records through it when `BGE_RECORD_UPSTREAM=true`, and #614's
 * stubbed upstreams can be refreshed the same way.
 *
 * An answer other than a 200, such as BGG's 202 while it prepares one, is
 * handed back but not recorded. The recorder decides what to keep: a token
 * endpoint's answer holds a credential, so it should keep none of those.
 */
export function createRecordingFetch(
  record: (request: RecordedRequest, body: string) => void,
  fetch: UpstreamFetch = (url, request) => globalThis.fetch(url, request),
): UpstreamFetch {
  return async (url, request) => {
    const response = await fetch(url, request);
    const body = await response.text();

    if (response.status === 200) {
      record({ url: new URL(url), method: request.method, body: request.body }, body);
    }

    return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
