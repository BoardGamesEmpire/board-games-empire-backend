/**
 * Suite-agnostic plumbing for wire-contract parsers.
 *
 * `supertest` types `response.body` as `any`, so every assertion against it is
 * unchecked by construction: a renamed envelope key surfaces as
 * `expect(undefined).toBe(...)`, which names neither the key nor the change.
 * Each aggregate's suite answers that with a `*-wire.ts` module of fail-loud
 * parsers; what lives HERE is the part none of them own individually.
 *
 * Extracted from `household/household-wire.ts` (#257) when the feedback suite
 * became the second consumer (#262). Held back until then on purpose — the
 * same concrete-first rule #257 applied to invite fixtures — because the
 * shape worth sharing is only visible once two callers want it. What moved is
 * strictly the aggregate-independent half: the JSON projection, the response
 * shape, and the failure message. Every envelope parser stays with its suite.
 */

/** `GET /api/households/:id`, `POST /api/feedback/reports`, … — for messages. */
export type RequestDescription = string;

/**
 * JSON projection of a Prisma row: `Date` columns arrive over the wire as ISO
 * strings, everything else survives unchanged. Derived from the model type
 * rather than restated, so a schema change surfaces as a type error at the
 * assertion site instead of as a silently vacuous assertion.
 */
export type Wire<TRow> = {
  [TKey in keyof TRow]: TRow[TKey] extends Date ? string : TRow[TKey] extends Date | null ? string | null : TRow[TKey];
};

/**
 * The subset of a `supertest` response the parsers read. Declared structurally
 * rather than as supertest's `Response` so parsers can be unit-tested against
 * plain objects with no cast — a `Response` is assignable to this, since
 * `body: any` satisfies `body: unknown`.
 */
export interface HttpResponseLike {
  readonly status: number;
  readonly body: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A short, safe rendering of an unexpected body for a failure message. */
function preview(body: unknown): string {
  try {
    const serialized = JSON.stringify(body);
    return serialized === undefined ? String(body) : serialized.slice(0, 300);
  } catch {
    return '<unserializable body>';
  }
}

/**
 * Builds the `fail` used by one suite's parsers, closing over the file a
 * reader has to edit when an envelope changes.
 *
 * The path is a parameter rather than derived: naming the WRONG file is worse
 * than naming none, and each suite's parsers know which module they live in
 * while this one cannot.
 *
 * The return type is annotated rather than inferred. Call sites use it as
 * `return fail(...)`, which only typechecks while the closure returns `never`;
 * an edit that added a non-throwing path would widen the inference and break
 * those call sites instead of this one.
 */
export function envelopeFailure(
  ownerFile: string,
): (what: string, request: RequestDescription, response: HttpResponseLike) => never {
  return function fail(what: string, request: RequestDescription, response: HttpResponseLike): never {
    throw new Error(
      `${request} returned ${response.status} but ${what}. The response envelope has changed — ` +
        `update ${ownerFile} to match. Body: ${preview(response.body)}`,
    );
  };
}
