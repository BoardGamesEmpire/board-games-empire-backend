import type { Household, HouseholdMember } from '@bge/database';
import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription, type Wire } from '../support/wire';

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
 * The aggregate-independent half of that machinery — `Wire`, `HttpResponseLike`,
 * and the failure message — moved to `../support/wire.ts` when the feedback
 * suite became its second consumer (#262). Re-exported below so this module's
 * public surface is unchanged.
 *
 * The constraint name below is inlined rather than imported from `@bge/household`
 * deliberately, matching the reasoning in `signup.ts`: this suite is black-box,
 * and importing the product lib would pull its Nest module graph (controller
 * decorators, `@bge/permissions`, `@bge/i18n`, rxjs) into the test process to
 * read one string. What is asserted here is what POSTGRES reports, which is a
 * database fact rather than an application constant.
 */

export type { HttpResponseLike, RequestDescription, Wire } from '../support/wire';

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

export interface PaginationWire {
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly totalPages: number;
  readonly hasMore: boolean;
}

export interface ListHouseholdsEnvelope {
  readonly households: readonly HouseholdWire[];
  readonly pagination: PaginationWire;
}

const fail = envelopeFailure('apps/api-e2e/src/household/household-wire.ts');

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

const isNonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Narrows the shared pagination envelope (#230). Every field is checked, unlike
 * the household rows above: this envelope is the contract the endpoint gained,
 * so a missing or mistyped member of it is exactly the regression worth failing
 * on — and a client that reads `hasMore` off `undefined` pages forever.
 *
 * The types alone are not the contract, so the ranges and the two derived
 * relations are checked as well: `page` is 1-based, `totalPages` is the ceiling
 * of `total / limit` (zero rows meaning zero pages), and `hasMore` says whether
 * a page follows this one. A response satisfying the types but not the
 * arithmetic — `page: -1`, `limit: 0`, a `totalPages` that contradicts `total`
 * — is a server bug the suite should fail on, not narrow past.
 */
function asPagination(value: unknown): PaginationWire | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { page, limit, total, totalPages, hasMore } = value;

  if (![page, limit, total, totalPages].every(isNonNegativeInteger) || typeof hasMore !== 'boolean') {
    return undefined;
  }

  // Narrowed by the guard above; destructured members do not carry it through.
  const [pageNumber, pageSize, rowCount, pageCount] = [page, limit, total, totalPages] as number[];

  if (pageNumber < 1 || pageSize < 1) {
    return undefined;
  }

  if (pageCount !== Math.ceil(rowCount / pageSize) || hasMore !== pageNumber < pageCount) {
    return undefined;
  }

  return value as unknown as PaginationWire;
}

/** `GET /api/households`: `{ households: [...], pagination }`. */
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

  const pagination = asPagination(response.body['pagination']);
  if (pagination === undefined) {
    return fail(
      "it carried no 'pagination' envelope whose page, limit, total, totalPages and hasMore agree",
      request,
      response,
    );
  }

  // Both bounds on the row count, and only the upper ones. `limit` is the page's
  // declared capacity, so a longer page means a `take` stopped being applied —
  // the unbounded read the pagination caps exist to prevent (#11). `total` counts
  // the same actor-scoped set the rows came from, so a page longer than the total
  // means the two disagree about scope, which is what the shared snapshot exists
  // to rule out (#230).
  //
  // A SHORT page stays legitimate under both — it is the last page, or a read
  // that filters rows after the query — so the tempting stronger rules ("full
  // whenever hasMore is set", "equal to total on a single page") would fail the
  // suite for correct responses.
  if (rows.length > pagination.limit) {
    return fail(
      `it carried ${rows.length} households, more than its pagination limit of ${pagination.limit}`,
      request,
      response,
    );
  }

  if (rows.length > pagination.total) {
    return fail(
      `it carried ${rows.length} households, more than the total of ${pagination.total} it declares`,
      request,
      response,
    );
  }

  // The third of the three server-side arguments, one check each: `take` (limit),
  // the scoped count (total), and now `skip`. Past the final page the derived
  // skip exceeds every matching row, so rows there mean the skip was dropped or
  // mis-derived — a regression the other two bounds sail past, since those rows
  // fit both the page size and the total. An EMPTY out-of-range page is the
  // honest answer and stays valid.
  if (rows.length > 0 && pagination.page > pagination.totalPages) {
    return fail(
      `it carried ${rows.length} households for page ${pagination.page}, after its final page ${pagination.totalPages}`,
      request,
      response,
    );
  }

  return { households: rows, pagination };
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
 * reported (#257). The first run against a real database said otherwise,
 * and the consequence was not a wrong constant: `HouseholdService` discriminated
 * replays on `meta.target`, so it matched nothing, every keyed retry rethrew, and
 * #210's guarantee had inverted into a 500 on exactly the request it exists to
 * make safe. Same defect in `FeedbackService` (#251).
 *
 * Both now key replay off the presence of a row under the composite key, which is
 * shape-independent, so neither reads `meta.target` any more.
 *
 * NO READER REMAINS. `HouseholdMemberService.isDuplicateMembership` was the last
 * one; #298 moved it onto the constraint identity under
 * `meta.driverAdapterError.cause.constraint`, which is populated. It could not
 * adopt the row-lookup fix — it runs inside a transaction Postgres has already
 * aborted, so it cannot re-read — and it answers a documented 409 when the payload
 * carries no identity, so nothing in the application depends on `meta.target`.
 *
 * What remains worth asserting is the assumption itself — see the probe in
 * `household-idempotency.spec.ts` for this constraint, and
 * `apps/api-e2e/src/database/p2002-shape.spec.ts` for the shape the member
 * discriminator reads. If a future Prisma populates `target`, those tests go red
 * and this note is where to start reading; a populated target would be welcome but
 * must not quietly become load-bearing again.
 */
export const P2002_REPORTS_NO_USABLE_TARGET = true;

/**
 * Normalizes a `meta.target` to the list of names a `meta`-sniffing
 * discriminator would have tested. Retained after that approach was removed from
 * `HouseholdService` and `FeedbackService`, because asserting this comes back
 * EMPTY is how the probe pins the finding above without depending on whether
 * `meta` is absent entirely or merely lacks a `target`.
 *
 * NOT the production normalizer. `constraintIdentity` in `@bge/database` is that,
 * and it reads a union of sources rather than `target` alone. This stays local to
 * the suite because its whole job is to assert an ABSENCE, which the production
 * helper deliberately reports as `unknown` rather than as an empty list.
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
