import { paginated, paginatedEnvelopeSchema, PaginatedResponseDto } from './paginated-response.dto';

const rowsOf = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index + 1 }));

describe('paginated — the shared list envelope', () => {
  it('nests the rows under the resource key', () => {
    const envelope = paginated('households', { rows: rowsOf(2), total: 2 }, { page: 1, pageSize: 25 });

    expect(envelope.households).toHaveLength(2);
  });

  it('echoes the resolved page size as pagination.limit', () => {
    const envelope = paginated('households', { rows: rowsOf(10), total: 10 }, { page: 1, pageSize: 10 });

    expect(envelope.pagination).toMatchObject({ page: 1, limit: 10, total: 10 });
  });

  // D-230-2: `total` is unconditional precisely so a UI can render "page 3 of 12".
  it('derives totalPages from total and page size, rounding up a partial last page', () => {
    expect(paginated('games', { rows: rowsOf(25), total: 51 }, { page: 1, pageSize: 25 }).pagination.totalPages).toBe(
      3,
    );
  });

  it('reports totalPages 0 for an empty result rather than 1', () => {
    const { pagination } = paginated('games', { rows: [], total: 0 }, { page: 1, pageSize: 25 });

    expect(pagination).toMatchObject({ total: 0, totalPages: 0, hasMore: false });
  });

  describe('hasMore boundary behaviour', () => {
    it('is true when rows remain after this page', () => {
      expect(paginated('games', { rows: rowsOf(25), total: 26 }, { page: 1, pageSize: 25 }).pagination.hasMore).toBe(
        true,
      );
    });

    // The case the old bare-array shape forced clients to guess at: a full page
    // that happens to be the last one. A short-page heuristic gets this wrong.
    it('is false on a full page that is exactly the end of the result set', () => {
      expect(paginated('games', { rows: rowsOf(25), total: 25 }, { page: 1, pageSize: 25 }).pagination.hasMore).toBe(
        false,
      );
    });

    it('is false on the final partial page', () => {
      expect(paginated('games', { rows: rowsOf(5), total: 30 }, { page: 2, pageSize: 25 }).pagination.hasMore).toBe(
        false,
      );
    });

    it('is false past the end of the result set, with the requested page echoed back', () => {
      const { pagination } = paginated('games', { rows: [], total: 30 }, { page: 9, pageSize: 25 });

      expect(pagination).toMatchObject({ page: 9, hasMore: false, total: 30, totalPages: 2 });
    });

    it('is true on a middle page', () => {
      expect(paginated('games', { rows: rowsOf(25), total: 200 }, { page: 4, pageSize: 25 }).pagination.hasMore).toBe(
        true,
      );
    });
  });
});

describe('PaginatedResponseDto — the generated Swagger model', () => {
  class Widget {
    id!: string;
  }

  it('returns one class per (model, resourceKey), so a schema name is registered once', () => {
    expect(PaginatedResponseDto(Widget, 'widgets')).toBe(PaginatedResponseDto(Widget, 'widgets'));
  });

  it('names the schema after the resource key and the model', () => {
    expect(PaginatedResponseDto(Widget, 'gadgets').name).toBe('PaginatedGadgetsOfWidget');
  });

  // Class names are not unique across this repo's libs, so a name-keyed cache
  // would hand a second, unrelated model the first one's schema.
  it('does not confuse two distinct models that happen to share a name', () => {
    const sameName = class Widget {
      id!: string;
    };

    const first = PaginatedResponseDto(Widget, 'items');
    const second = PaginatedResponseDto(sameName, 'items');

    expect(second).not.toBe(first);
    expect(second.name).not.toBe(first.name);
  });
});

describe('paginatedEnvelopeSchema — for endpoints with no row model yet', () => {
  it('requires both the rows and the pagination block', () => {
    expect(paginatedEnvelopeSchema('households').required).toEqual(['households', 'pagination']);
  });

  it('declares the rows as an array of unspecified objects rather than inventing fields', () => {
    expect(paginatedEnvelopeSchema('members').properties.members).toEqual({
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    });
  });

  it('references the real PaginationMetaDto schema, so the envelope is typed', () => {
    expect(paginatedEnvelopeSchema('members').properties.pagination).toEqual({
      $ref: '#/components/schemas/PaginationMetaDto',
    });
  });
});
