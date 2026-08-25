import {
  constraintTargetNames,
  createEnvelope,
  HOUSEHOLD_CLIENT_REQUEST_ID_CONSTRAINT,
  listEnvelope,
  readEnvelope,
  type HttpResponseLike,
} from './household-wire';

/**
 * The happy paths here are exercised on every assertion of every household
 * suite, so this file covers what a green suite never reaches: the failure
 * branches. Their whole value is the message they produce, and an unreachable
 * error path that formats badly is worse than none — it turns an envelope
 * change into a confusing test failure instead of a clear one.
 */
describe('household wire parsers (pure logic)', () => {
  const response = (body: unknown, status = 200): HttpResponseLike => ({ status, body });

  describe('createEnvelope', () => {
    it('returns the household and message from a well-formed envelope', () => {
      const parsed = createEnvelope(response({ message: 'created', household: { id: 'h1', name: 'n' } }, 201), 'POST');

      expect(parsed.household.id).toBe('h1');
      expect(parsed.message).toBe('created');
    });

    it('names the missing key, the status, and the file to update', () => {
      const act = () => createEnvelope(response({ data: { id: 'h1' } }, 201), 'POST /api/households');

      expect(act).toThrow(/POST \/api\/households returned 201/);
      expect(act).toThrow(/no 'household' object with a string id/);
      expect(act).toThrow(/household-wire\.ts/);
    });

    it('rejects a household whose id is absent or not a string', () => {
      expect(() => createEnvelope(response({ message: 'm', household: {} }), 'POST')).toThrow(/string id/);
      expect(() => createEnvelope(response({ message: 'm', household: { id: 42 } }), 'POST')).toThrow(/string id/);
      expect(() => createEnvelope(response({ message: 'm', household: { id: '' } }), 'POST')).toThrow(/string id/);
    });

    it('rejects a missing message rather than defaulting it', () => {
      // The message is part of the envelope contract the replay case asserts;
      // a replay must be indistinguishable from a create, and that
      // is only checkable if its absence is an error rather than undefined.
      expect(() => createEnvelope(response({ household: { id: 'h1' } }), 'POST')).toThrow(/no 'message' string/);
    });

    it('rejects a non-object body, including an array', () => {
      expect(() => createEnvelope(response('gateway timeout', 504), 'POST')).toThrow(/body is not an object/);
      expect(() => createEnvelope(response([{ id: 'h1' }]), 'POST')).toThrow(/body is not an object/);
    });

    it('includes a truncated body preview and survives an unserializable one', () => {
      expect(() => createEnvelope(response({ note: 'x'.repeat(1_000) }), 'POST')).toThrow(/x{50}/);

      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      expect(() => createEnvelope(response(circular), 'POST')).toThrow(/unserializable body/);
    });
  });

  describe('readEnvelope', () => {
    it('accepts a detail envelope carrying the members embed', () => {
      const parsed = readEnvelope(response({ household: { id: 'h1', members: [], languageTag: null } }), 'GET');

      expect(parsed.household.members).toEqual([]);
      expect(parsed.household.languageTag).toBeNull();
    });

    it('rejects a household without the members embed', () => {
      // getHouseholdById always includes members; a body without them means the
      // include changed, and the member-role assertions would quietly read
      // undefined instead of failing here.
      expect(() => readEnvelope(response({ household: { id: 'h1' } }), 'GET')).toThrow(/no 'members' array/);
    });
  });

  describe('listEnvelope', () => {
    const PAGINATION = { page: 1, limit: 25, total: 1, totalPages: 1, hasMore: false };

    it('accepts an empty list and a populated one', () => {
      expect(listEnvelope(response({ households: [], pagination: PAGINATION }), 'GET').households).toEqual([]);
      expect(
        listEnvelope(response({ households: [{ id: 'h1' }], pagination: PAGINATION }), 'GET').households,
      ).toHaveLength(1);
    });

    it('rejects a body whose households key is absent or not an array', () => {
      expect(() => listEnvelope(response({}), 'GET')).toThrow(/no 'households' array/);
      expect(() => listEnvelope(response({ households: { id: 'h1' } }), 'GET')).toThrow(/no 'households' array/);
    });

    it('rejects a list with a malformed entry rather than carrying it through', () => {
      expect(() => listEnvelope(response({ households: [{ id: 'h1' }, null], pagination: PAGINATION }), 'GET')).toThrow(
        /not an object/,
      );
    });

    // #230: the envelope is the contract the endpoint gained, so a response
    // missing it is a regression rather than an older-but-valid shape.
    it('carries the pagination envelope through', () => {
      expect(listEnvelope(response({ households: [{ id: 'h1' }], pagination: PAGINATION }), 'GET').pagination).toEqual(
        PAGINATION,
      );
    });

    it('rejects a body with no pagination envelope', () => {
      expect(() => listEnvelope(response({ households: [] }), 'GET')).toThrow(/no 'pagination' envelope/);
    });

    // The arithmetic is part of the contract, so a body that satisfies the types
    // and contradicts itself is still a server bug worth failing on.
    it('rejects a page number below one', () => {
      expect(() => listEnvelope(response({ households: [], pagination: { ...PAGINATION, page: 0 } }), 'GET')).toThrow(
        /no 'pagination' envelope/,
      );
    });

    it('rejects a zero page size', () => {
      expect(() => listEnvelope(response({ households: [], pagination: { ...PAGINATION, limit: 0 } }), 'GET')).toThrow(
        /no 'pagination' envelope/,
      );
    });

    it('rejects a totalPages that contradicts total and limit', () => {
      expect(() =>
        listEnvelope(
          response({ households: [], pagination: { page: 1, limit: 25, total: 60, totalPages: 1, hasMore: true } }),
          'GET',
        ),
      ).toThrow(/no 'pagination' envelope/);
    });

    it('rejects a hasMore that disagrees with the page count', () => {
      expect(() =>
        listEnvelope(
          response({ households: [], pagination: { page: 3, limit: 25, total: 60, totalPages: 3, hasMore: true } }),
          'GET',
        ),
      ).toThrow(/no 'pagination' envelope/);
    });

    it('accepts a coherent middle page', () => {
      const middle = { page: 2, limit: 25, total: 60, totalPages: 3, hasMore: true };

      expect(listEnvelope(response({ households: [], pagination: middle }), 'GET').pagination).toEqual(middle);
    });

    it('accepts an empty result reporting zero pages', () => {
      const empty = { page: 1, limit: 25, total: 0, totalPages: 0, hasMore: false };

      expect(listEnvelope(response({ households: [], pagination: empty }), 'GET').pagination).toEqual(empty);
    });

    it('rejects a page carrying more rows than its own limit', () => {
      expect(() =>
        listEnvelope(
          response({
            households: [{ id: 'h1' }, { id: 'h2' }],
            pagination: { page: 1, limit: 1, total: 2, totalPages: 2, hasMore: true },
          }),
          'GET',
        ),
      ).toThrow(/more than its pagination limit/);
    });

    it('accepts a page filled exactly to its limit', () => {
      const full = { page: 1, limit: 2, total: 2, totalPages: 1, hasMore: false };

      expect(
        listEnvelope(response({ households: [{ id: 'h1' }, { id: 'h2' }], pagination: full }), 'GET').households,
      ).toHaveLength(2);
    });

    it('rejects rows arriving under a total that cannot account for them', () => {
      expect(() =>
        listEnvelope(
          response({
            households: [{ id: 'h1' }],
            pagination: { page: 1, limit: 25, total: 0, totalPages: 0, hasMore: false },
          }),
          'GET',
        ),
      ).toThrow(/more than the total of 0/);
    });

    it('rejects rows outnumbering the total even when the page fits its limit', () => {
      expect(() =>
        listEnvelope(
          response({
            households: [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }],
            pagination: { page: 1, limit: 25, total: 2, totalPages: 1, hasMore: false },
          }),
          'GET',
        ),
      ).toThrow(/more than the total of 2/);
    });

    it('rejects rows on a page after the last one', () => {
      expect(() =>
        listEnvelope(
          response({
            households: [{ id: 'h1' }],
            pagination: { page: 2, limit: 25, total: 1, totalPages: 1, hasMore: false },
          }),
          'GET',
        ),
      ).toThrow(/after its final page 1/);
    });

    // The case a dropped `skip` produces: a full page of rows that fits both the
    // limit and the total, but arrives on a page that should be past the end.
    it('rejects a full page arriving beyond the final page', () => {
      expect(() =>
        listEnvelope(
          response({
            households: [{ id: 'h1' }, { id: 'h2' }],
            pagination: { page: 5, limit: 2, total: 8, totalPages: 4, hasMore: false },
          }),
          'GET',
        ),
      ).toThrow(/after its final page 4/);
    });

    it('accepts an empty page past the end, which is the honest answer', () => {
      const pastEnd = { page: 9, limit: 25, total: 30, totalPages: 2, hasMore: false };

      expect(listEnvelope(response({ households: [], pagination: pastEnd }), 'GET').pagination).toEqual(pastEnd);
    });

    it('rejects a pagination envelope with a mistyped member', () => {
      expect(() =>
        listEnvelope(response({ households: [], pagination: { ...PAGINATION, hasMore: 'yes' } }), 'GET'),
      ).toThrow(/no 'pagination' envelope/);
      expect(() =>
        listEnvelope(response({ households: [], pagination: { ...PAGINATION, total: '3' } }), 'GET'),
      ).toThrow(/no 'pagination' envelope/);
    });
  });

  describe('constraintTargetNames', () => {
    it('wraps a string target', () => {
      expect(constraintTargetNames(HOUSEHOLD_CLIENT_REQUEST_ID_CONSTRAINT)).toEqual([
        HOUSEHOLD_CLIENT_REQUEST_ID_CONSTRAINT,
      ]);
    });

    it('keeps only the string entries of an array target', () => {
      expect(constraintTargetNames(['created_by_id', 'client_request_id'])).toEqual([
        'created_by_id',
        'client_request_id',
      ]);
      expect(constraintTargetNames(['client_request_id', 7, null])).toEqual(['client_request_id']);
    });

    it('yields nothing for an absent or unrecognized target', () => {
      expect(constraintTargetNames(undefined)).toEqual([]);
      expect(constraintTargetNames({ fields: ['client_request_id'] })).toEqual([]);
    });
  });

  it('returns nothing for the shape Prisma actually reports', () => {
    // The measured case (2026-08-10): no `meta` at all, and therefore no names.
    // This is what the e2e probe asserts against a real database; pinning it
    // here too keeps the normalizer honest without needing Postgres.
    expect(constraintTargetNames(undefined)).toEqual([]);
  });
});
