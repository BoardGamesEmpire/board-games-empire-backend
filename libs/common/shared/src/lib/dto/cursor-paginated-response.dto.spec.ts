import { DECORATORS } from '@nestjs/swagger';
import { ClsServiceManager } from 'nestjs-cls';
import { decodeKeysetCursor } from '../pagination/keyset-cursor';
import { Unscoped } from '../scope/list-scope.js';
import { ListScopeNotComposedError } from '../scope/unscoped-list.error.js';
import {
  ApiCursorPaginatedEnvelope,
  cursorPage,
  cursorPaginated,
  CursorPaginationMetaDto,
} from './cursor-paginated-response.dto';

/** Newest first, as a read ordered by `createdAt` desc, `id` desc returns them (#1597). */
const rowsOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `row-${String(count - index).padStart(3, '0')}`,
    createdAt: new Date(Date.UTC(2026, 10, 27, 12, 0, count - index)),
  }));

/** Applies a method decorator to a probe class's `list` route, as Nest does at class definition. */
const applyToList = (decorator: MethodDecorator, probe: { prototype: { list: () => void } }) => {
  const descriptor = Object.getOwnPropertyDescriptor(probe.prototype, 'list');

  if (descriptor === undefined) {
    throw new Error('the probe class has no list method');
  }

  decorator(probe.prototype, 'list', descriptor);
};

/** These cases exercise the envelope, not the scope guard, which has its own cases below (#1597). */
const ENVELOPE_ONLY = Unscoped('envelope arithmetic under test; no read behind it');

describe('cursorPage — trimming the read of pageSize + 1 (#1597)', () => {
  it('keeps pageSize rows and encodes the last kept row when a row was cut', () => {
    const read = rowsOf(4);

    const { rows, nextCursor } = cursorPage(read, 3);

    expect(rows).toEqual(read.slice(0, 3));
    expect(nextCursor).not.toBeNull();
    expect(decodeKeysetCursor(nextCursor ?? '')).toEqual({ createdAt: read[2].createdAt, id: read[2].id });
  });

  it('has no cursor when the read holds exactly pageSize rows', () => {
    const read = rowsOf(3);

    expect(cursorPage(read, 3)).toEqual({ rows: read, nextCursor: null });
  });

  it('has no cursor when the read holds fewer than pageSize rows', () => {
    const read = rowsOf(2);

    expect(cursorPage(read, 3)).toEqual({ rows: read, nextCursor: null });
  });

  it('returns no rows and no cursor for an empty read', () => {
    expect(cursorPage([], 3)).toEqual({ rows: [], nextCursor: null });
  });

  it('does not mutate the read', () => {
    const read = rowsOf(4);

    cursorPage(read, 3);

    expect(read).toHaveLength(4);
  });
});

describe('cursorPaginated — the cursor list envelope (#1597)', () => {
  it('nests the rows under the resource key', () => {
    const rows = rowsOf(2);

    const envelope = cursorPaginated('notifications', { rows, nextCursor: null }, { pageSize: 25 }, ENVELOPE_ONLY);

    expect(envelope.notifications).toEqual(rows);
  });

  it('echoes the resolved page size as pagination.limit', () => {
    const { pagination } = cursorPaginated(
      'notifications',
      { rows: [], nextCursor: null },
      { pageSize: 10 },
      ENVELOPE_ONLY,
    );

    expect(pagination.limit).toBe(10);
  });

  it('carries the next cursor and reports hasMore when there is one', () => {
    const { pagination } = cursorPaginated(
      'notifications',
      { rows: rowsOf(1), nextCursor: 'abc' },
      { pageSize: 1 },
      ENVELOPE_ONLY,
    );

    expect(pagination).toEqual({ limit: 1, hasMore: true, nextCursor: 'abc' });
  });

  it('reports a null cursor and no more on the last page', () => {
    const { pagination } = cursorPaginated(
      'notifications',
      { rows: rowsOf(1), nextCursor: null },
      { pageSize: 25 },
      ENVELOPE_ONLY,
    );

    expect(pagination).toEqual({ limit: 25, hasMore: false, nextCursor: null });
  });

  // The last page sends `nextCursor: null`, so the schema must say it can be
  // null, or a generated client types it as a plain string (#1597).
  it('documents nextCursor as nullable in the OpenAPI schema', () => {
    const property = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      CursorPaginationMetaDto.prototype,
      'nextCursor',
    );

    expect(property).toMatchObject({ nullable: true });
  });

  it('has no total and no page, which a cursor list cannot know (#1597)', () => {
    const { pagination } = cursorPaginated(
      'notifications',
      { rows: [], nextCursor: null },
      { pageSize: 25 },
      ENVELOPE_ONLY,
    );

    expect(Object.keys(pagination).sort()).toEqual(['hasMore', 'limit', 'nextCursor']);
  });

  it('refuses to build an envelope for a read whose scope was never composed', () => {
    ClsServiceManager.getClsService().runWith({}, () => {
      expect(() => cursorPaginated('quotas', { rows: [], nextCursor: null }, { pageSize: 25 }, 'Quota')).toThrow(
        ListScopeNotComposedError,
      );
    });
  });
});

/**
 * The envelope schema `$ref`s `CursorPaginationMetaDto`, which resolves only if
 * something registers that model. The decorator applies both, as
 * `ApiPaginatedEnvelope` does (#1597).
 */
describe('ApiCursorPaginatedEnvelope — the schema and its model registration, together (#1597)', () => {
  class Probe {
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- a probe route; only its decorators matter (#1321)
    list() {}
  }

  beforeAll(() => {
    applyToList(ApiCursorPaginatedEnvelope('widgets'), Probe);
  });

  it('registers CursorPaginationMetaDto, so the envelope’s $ref resolves', () => {
    const extraModels = Reflect.getMetadata(DECORATORS.API_EXTRA_MODELS, Probe.prototype.list) ?? [];

    expect(extraModels).toContain(CursorPaginationMetaDto);
  });

  it('requires the rows and the pagination block, and references the meta model', () => {
    const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, Probe.prototype.list) ?? {};

    expect(responses['200'].schema).toEqual({
      type: 'object',
      required: ['widgets', 'pagination'],
      properties: {
        widgets: { type: 'array', items: { type: 'object', additionalProperties: true } },
        pagination: { $ref: '#/components/schemas/CursorPaginationMetaDto' },
      },
    });
  });

  it('defaults the description to the resource, and lets a route override the status and description', () => {
    class Custom {
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- a probe route; only its decorators matter (#1321)
      list() {}
    }
    applyToList(ApiCursorPaginatedEnvelope('widgets', { status: 201, description: 'Only the visible ones' }), Custom);

    expect(Reflect.getMetadata(DECORATORS.API_RESPONSE, Probe.prototype.list)['200'].description).toBe(
      'Paginated widgets',
    );
    expect(Reflect.getMetadata(DECORATORS.API_RESPONSE, Custom.prototype.list)['201'].description).toBe(
      'Only the visible ones',
    );
  });
});
