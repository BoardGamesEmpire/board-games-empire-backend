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
      // The message is part of the envelope contract the replay case asserts
      // (D-257-9): a replay must be indistinguishable from a create, and that
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
    it('accepts an empty list and a populated one', () => {
      expect(listEnvelope(response({ households: [] }), 'GET').households).toEqual([]);
      expect(listEnvelope(response({ households: [{ id: 'h1' }] }), 'GET').households).toHaveLength(1);
    });

    it('rejects a body whose households key is absent or not an array', () => {
      expect(() => listEnvelope(response({}), 'GET')).toThrow(/no 'households' array/);
      expect(() => listEnvelope(response({ households: { id: 'h1' } }), 'GET')).toThrow(/no 'households' array/);
    });

    it('rejects a list with a malformed entry rather than carrying it through', () => {
      expect(() => listEnvelope(response({ households: [{ id: 'h1' }, null] }), 'GET')).toThrow(/not an object/);
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
