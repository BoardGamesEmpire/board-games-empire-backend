import type { Household, HouseholdMember } from '@bge/database';

/**
 * Wire-contract types and fail-loud response parsers shared by the household
 * e2e suites (#257).
 *
 * Why parsers rather than casts: `supertest`'s `response.body` is `any`, so
 * every assertion against it is unchecked by construction — a renamed envelope
 * key surfaces as `expect(undefined).toBe('...')`, which names neither the key
 * nor the change. These functions validate the minimum that makes the typing
 * honest and throw something actionable otherwise, the same contract
 * `@bge/testing-e2e`'s `extractUserId` / `extractSessionToken` hold for the
 * signup response.
 *
 * The constraint name below is inlined rather than imported from `@bge/household`
 * deliberately, matching the reasoning in `signup.ts`: this suite is black-box,
 * and importing the product lib would pull its Nest module graph (controller
 * decorators, `@bge/permissions`, `@bge/i18n`, rxjs) into the test process to
 * read one string. What is asserted here is what POSTGRES reports, which is a
 * database fact rather than an application constant.
 */

/** `GET /api/households/:id`, `POST /api/households`, etc. — for error messages. */
export type RequestDescription = string;

/**
 * JSON projection of a Prisma row: `Date` columns arrive over the wire as ISO
 * strings, everything else survives unchanged. Derived from the model type
 * rather than restated, so a schema change surfaces as a type error here
 * instead of as a silently vacuous assertion.
 */
export type Wire<TRow> = {
  [TKey in keyof TRow]: TRow[TKey] extends Date ? string : TRow[TKey] extends Date | null ? string | null : TRow[TKey];
};

export type HouseholdWire = Wire<Household>;
export type HouseholdMemberWire = Wire<HouseholdMember>;

/** The `role` embed on a member in `getHouseholdById`'s include. */
export interface HouseholdRoleProjection {
  readonly role: { readonly id: string; readonly name: string };
}

export interface HouseholdMemberProjection extends HouseholdMemberWire {
  readonly role: HouseholdRoleProjection | null;
}

/** The `languageTag` select in `getHouseholdById` / `getHouseholdsForUser`. */
export interface LanguageTagProjection {
  readonly id: string;
  readonly tag: string;
}

/** `getHouseholdById`'s shape: the row plus its member and language embeds. */
export interface HouseholdDetail extends HouseholdWire {
  readonly languageTag: LanguageTagProjection | null;
  readonly members: readonly HouseholdMemberProjection[];
}

export interface CreateHouseholdEnvelope {
  readonly message: string;
  readonly household: HouseholdWire;
}

export interface ReadHouseholdEnvelope {
  readonly household: HouseholdDetail;
}

export interface ListHouseholdsEnvelope {
  readonly households: readonly HouseholdWire[];
}

/**
 * The subset of a `supertest` response these parsers read. Declared
 * structurally rather than as supertest's `Response` so the parsers can be
 * unit-tested against plain objects with no cast — a `Response` is assignable
 * to this, since `body: any` satisfies `body: unknown`.
 */
export interface HttpResponseLike {
  readonly status: number;
  readonly body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

function fail(what: string, request: RequestDescription, response: HttpResponseLike): never {
  throw new Error(
    `${request} returned ${response.status} but ${what}. The response envelope has changed — ` +
      `update apps/api-e2e/src/household/household-wire.ts to match. Body: ${preview(response.body)}`,
  );
}

/**
 * Narrows an unknown value to a household row: an object carrying a non-empty
 * string `id`. Only `id` is checked, on purpose — it is the one field every
 * caller depends on, and validating the full column set here would make this
 * module a second copy of the Prisma schema that has to be maintained in step
 * with it.
 */
function asHousehold(value: unknown): HouseholdWire | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = value['id'];

  return typeof id === 'string' && id.length > 0 ? (value as unknown as HouseholdWire) : undefined;
}

/** `POST /api/households` / `PATCH` / `DELETE`: `{ message, household }`. */
export function createEnvelope(response: HttpResponseLike, request: RequestDescription): CreateHouseholdEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const household = asHousehold(response.body['household']);
  if (household === undefined) {
    return fail("it carried no 'household' object with a string id", request, response);
  }

  const message = response.body['message'];
  if (typeof message !== 'string') {
    return fail("it carried no 'message' string", request, response);
  }

  return { message, household };
}

/** `GET /api/households/:id`: `{ household }` with member and language embeds. */
export function readEnvelope(response: HttpResponseLike, request: RequestDescription): ReadHouseholdEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const household = asHousehold(response.body['household']);
  if (household === undefined) {
    return fail("it carried no 'household' object with a string id", request, response);
  }

  if (!Array.isArray((household as unknown as HouseholdDetail).members)) {
    return fail("the household carried no 'members' array", request, response);
  }

  return { household: household as unknown as HouseholdDetail };
}

/** `GET /api/households`: `{ households: [...] }`. */
export function listEnvelope(response: HttpResponseLike, request: RequestDescription): ListHouseholdsEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const households = response.body['households'];
  if (!Array.isArray(households)) {
    return fail("it carried no 'households' array", request, response);
  }

  const rows: HouseholdWire[] = [];
  for (const entry of households) {
    const row = asHousehold(entry);
    if (row === undefined) {
      return fail('one of its households is not an object with a string id', request, response);
    }

    rows.push(row);
  }

  return { households: rows };
}

/**
 * DB name of the `@@unique([createdById, clientRequestId])` constraint, as
 * mapped in `prisma/models/household/household.prisma`. Mirrors
 * `HOUSEHOLD_CLIENT_REQUEST_ID_CONSTRAINT` in `@bge/household` — see the file
 * header for why it is inlined rather than imported.
 */
export const HOUSEHOLD_CLIENT_REQUEST_ID_CONSTRAINT = 'household_created_by_client_request_id_unique';

/**
 * MEASURED, 2026-08-10: a P2002 from this constraint arrives with NO usable
 * `meta.target` under `@prisma/client@7.8.0` + `PrismaPg` on Postgres 17.
 *
 * This began as a pinned expectation that the mapped constraint name would be
 * reported (#257 D-257-2). The first run against a real database said otherwise,
 * and the consequence was not a wrong constant: `HouseholdService` discriminated
 * replays on `meta.target`, so it matched nothing, every keyed retry rethrew, and
 * #210's guarantee had inverted into a 500 on exactly the request it exists to
 * make safe. Same defect in `FeedbackService` (#251).
 *
 * Both now key replay off the presence of a row under the composite key, which is
 * shape-independent, so neither reads `meta.target` any more.
 *
 * ONE READER REMAINS: `HouseholdMemberService.isDuplicateMembership` still
 * compares against `meta.target` and therefore still never matches, so a
 * concurrent duplicate admission answers 500 instead of 409 (#298). It cannot use
 * the row-lookup fix — it runs inside a transaction Postgres has already aborted
 * — and must read `meta.driverAdapterError.cause.constraint.fields` instead.
 *
 * What remains worth asserting is the assumption itself — see the probe in
 * `household-idempotency.spec.ts`. If a future Prisma populates `target`, that
 * test goes red and this note is where to start reading; a populated target would
 * be welcome but must not quietly become load-bearing again.
 */
export const P2002_REPORTS_NO_USABLE_TARGET = true;

/**
 * Normalizes a `meta.target` to the list of names a `meta`-sniffing
 * discriminator would have tested. Retained after that approach was removed from
 * `HouseholdService` and `FeedbackService`, because asserting this comes back
 * EMPTY is how the probe pins the finding above without depending on whether
 * `meta` is absent entirely or merely lacks a `target`.
 */
export function constraintTargetNames(target: unknown): string[] {
  if (typeof target === 'string') {
    return [target];
  }

  if (Array.isArray(target)) {
    return target.filter((entry): entry is string => typeof entry === 'string');
  }

  return [];
}
