import { submitEnvelope, type HttpResponseLike } from './feedback-wire';

/**
 * The happy path here runs on every assertion of every feedback suite, so this
 * file covers what a green suite never reaches: the failure branches. Their
 * whole value is the message they produce — an unreachable error path that
 * formats badly turns an envelope change into a confusing failure rather than a
 * clear one. Mirrors `household/household-wire.spec.ts`.
 */
describe('feedback wire parsers (pure logic)', () => {
  const response = (body: unknown, status = 201): HttpResponseLike => ({ status, body });
  const receipt = { id: 'r1', createdAt: '2026-08-19T00:00:00.000Z' };

  describe('submitEnvelope', () => {
    it('returns the receipt and message from a well-formed envelope', () => {
      const parsed = submitEnvelope(response({ message: 'submitted', feedbackReport: receipt }), 'POST');

      expect(parsed.feedbackReport).toEqual(receipt);
      expect(parsed.message).toBe('submitted');
    });

    it('names the missing key, the status, and the file to update', () => {
      const act = () => submitEnvelope(response({ data: receipt }), 'POST /api/feedback/reports');

      expect(act).toThrow(/POST \/api\/feedback\/reports returned 201/);
      expect(act).toThrow(/no 'feedbackReport' object with a string id and createdAt/);
      expect(act).toThrow(/feedback-wire\.ts/);
    });

    it('rejects a receipt whose id is absent, empty, or not a string', () => {
      const withId = (id: unknown) => () =>
        submitEnvelope(response({ message: 'm', feedbackReport: { ...receipt, id } }), 'POST');

      expect(withId(undefined)).toThrow(/string id/);
      expect(withId('')).toThrow(/string id/);
      expect(withId(42)).toThrow(/string id/);
    });

    it('rejects a receipt with no createdAt, which is half the contract', () => {
      expect(() => submitEnvelope(response({ message: 'm', feedbackReport: { id: 'r1' } }), 'POST')).toThrow(
        /createdAt/,
      );
    });

    it('rejects an envelope with no message string', () => {
      expect(() => submitEnvelope(response({ feedbackReport: receipt }), 'POST')).toThrow(/no 'message' string/);
    });

    it('rejects a body that is not an object, including an array', () => {
      expect(() => submitEnvelope(response('nope'), 'POST')).toThrow(/the body is not an object/);
      expect(() => submitEnvelope(response([receipt]), 'POST')).toThrow(/the body is not an object/);
      expect(() => submitEnvelope(response(null), 'POST')).toThrow(/the body is not an object/);
    });

    it('includes a body preview so the failure shows what arrived', () => {
      expect(() => submitEnvelope(response({ error: 'Too Many Requests' }, 429), 'POST')).toThrow(/Too Many Requests/);
    });

    it('narrows to exactly the receipt fields, dropping anything else the server sent', () => {
      // The receipt is deliberately minimal (no status, no redaction flags), so
      // a widened response should not silently become assertable through here.
      const parsed = submitEnvelope(
        response({ message: 'm', feedbackReport: { ...receipt, status: 'Triaged' } }),
        'POST',
      );

      expect(parsed.feedbackReport).toEqual(receipt);
    });
  });
});
