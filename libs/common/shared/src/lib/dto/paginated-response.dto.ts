import type { Type as NestType } from '@nestjs/common';
import { ApiProperty, getSchemaPath } from '@nestjs/swagger';

/** Metadata attached to every paginated list response. */
export class PaginationMetaDto {
  @ApiProperty({ description: 'The page returned, 1-based', example: 1 })
  page!: number;

  @ApiProperty({ description: 'Page size used for this response', example: 25 })
  limit!: number;

  @ApiProperty({ description: 'Total rows matching the query, across all pages', example: 137 })
  total!: number;

  @ApiProperty({ description: 'Number of pages at this page size', example: 6 })
  totalPages!: number;

  @ApiProperty({ description: 'Whether a further page exists after this one', example: true })
  hasMore!: boolean;
}

/** The rows a service read, plus the count of everything matching the query. */
export interface PaginatedRows<T> {
  rows: T[];
  total: number;
}

/**
 * The resolved paging a response was built with. Satisfied by any
 * `PaginationQueryDto`, so a controller passes its query DTO straight through
 * and cannot echo a `limit` the read did not use.
 */
export interface ResolvedPaging {
  page: number;
  pageSize: number;
}

export type PaginatedResponse<K extends string, T> = { [P in K]: T[] } & { pagination: PaginationMetaDto };

/**
 * Builds the shared list envelope: the rows under their resource key, plus
 * pagination metadata.
 *
 * `total` is unconditional — there is no `?withCount=true` opt-out — because it
 * is what tells a user how much they are paging through; a UI cannot render
 * "page 3 of 12" from `hasMore` alone, and an opt-in flag is one every client
 * sets anyway. The cost is a `count()` alongside the read, which callers should
 * issue in one `$transaction` so the count and the rows see the same snapshot.
 * See D-230-2 on #230.
 *
 * `hasMore` is kept even though `page`/`totalPages` make it derivable: it is
 * free once `total` is known, and it is the field a client's paging loop
 * terminates on without doing arithmetic.
 */
export function paginated<K extends string, T>(
  resourceKey: K,
  { rows, total }: PaginatedRows<T>,
  { page, pageSize }: ResolvedPaging,
): PaginatedResponse<K, T> {
  const pagination: PaginationMetaDto = {
    page,
    limit: pageSize,
    total,
    totalPages: Math.ceil(total / pageSize),
    hasMore: page * pageSize < total,
  };

  return { [resourceKey]: rows, pagination } as PaginatedResponse<K, T>;
}

/**
 * OpenAPI schema for a paginated list whose ROW type is not modelled yet: the
 * `pagination` block is a real `$ref`, and the rows are declared as an array of
 * objects with an unspecified shape.
 *
 * Preferred over {@link PaginatedResponseDto} only where no row DTO exists —
 * households and household members carry none, and inventing a partial one
 * would document fields the endpoint may not return, which is worse than
 * declaring the shape unknown. A generated client still sees that the body is
 * an envelope and that `pagination` is required, which a bare `description`
 * never told it. Modelling those rows is #376.
 *
 * Requires `＠ApiExtraModels(PaginationMetaDto)` on the controller, since the
 * `$ref` is the only mention of that model in the document.
 */
export function paginatedEnvelopeSchema(resourceKey: string) {
  return {
    type: 'object' as const,
    required: [resourceKey, 'pagination'],
    properties: {
      [resourceKey]: {
        type: 'array' as const,
        items: { type: 'object' as const, additionalProperties: true },
      },
      pagination: { $ref: getSchemaPath(PaginationMetaDto) },
    },
  };
}

const responseDtoCache = new WeakMap<NestType<unknown>, Map<string, NestType<unknown>>>();
const claimedSchemaNames = new Set<string>();

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * A schema name unique within the OpenAPI document. Class names are NOT unique
 * in this repo — `SearchQueryDto` and `UpdateEventOccurrenceDto` each exist
 * twice in different libs — and two schemas sharing a name means one silently
 * overwrites the other in `components.schemas`. The suffix is inert for every
 * model whose name is unclaimed, which is all of them today.
 */
function claimSchemaName(candidate: string): string {
  if (!claimedSchemaNames.has(candidate)) {
    claimedSchemaNames.add(candidate);

    return candidate;
  }

  let suffix = 2;
  while (claimedSchemaNames.has(`${candidate}${suffix}`)) {
    suffix += 1;
  }

  claimedSchemaNames.add(`${candidate}${suffix}`);

  return `${candidate}${suffix}`;
}

/**
 * Swagger response model for a paginated list: `{ <resourceKey>: Model[], pagination }`.
 *
 * A generated class rather than a hand-written `XListResponseDto` per endpoint,
 * so the envelope is documented in one place and cannot drift from what
 * {@link paginated} actually emits:
 *
 *   ＠ApiResponse({ status: Http.Ok, type: PaginatedResponseDto(HouseholdDto, 'households') })
 *
 * Results are cached per (model, resourceKey) so repeat calls return one class:
 * the generated class carries a `name` that becomes its OpenAPI schema name, and
 * building it twice would register two schemas under one name. The cache is keyed
 * on the model CONSTRUCTOR, not its name — keying on the name would hand a
 * second, unrelated `SearchQueryDto` the first one's schema.
 */
export function PaginatedResponseDto<T>(model: NestType<T>, resourceKey: string): NestType<unknown> {
  const perKey = responseDtoCache.get(model as NestType<unknown>) ?? new Map<string, NestType<unknown>>();
  const cached = perKey.get(resourceKey);

  if (cached) {
    return cached;
  }

  class PaginatedResponseModel {
    @ApiProperty({ type: PaginationMetaDto })
    pagination!: PaginationMetaDto;
  }

  // The resource key is dynamic, so the decorator is applied as the plain
  // function it is rather than through property-decorator syntax.
  ApiProperty({ type: model, isArray: true })(PaginatedResponseModel.prototype, resourceKey);

  Object.defineProperty(PaginatedResponseModel, 'name', {
    value: claimSchemaName(`Paginated${capitalize(resourceKey)}Of${model.name}`),
  });

  perKey.set(resourceKey, PaginatedResponseModel);
  responseDtoCache.set(model as NestType<unknown>, perKey);

  return PaginatedResponseModel;
}
