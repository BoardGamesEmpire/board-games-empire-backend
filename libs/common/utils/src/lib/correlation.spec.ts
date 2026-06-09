import { parseTraceparent, resolveCorrelationId } from './correlation.js';

describe('parseTraceparent', () => {
  it('extracts the trace_id from a valid traceparent', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    expect(parseTraceparent(traceparent)).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('trims surrounding whitespace', () => {
    const traceparent = '   00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01\t';
    expect(parseTraceparent(traceparent)).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('returns null for undefined input', () => {
    expect(parseTraceparent(undefined)).toBeNull();
  });

  it('returns null for malformed traceparent', () => {
    expect(parseTraceparent('not-a-traceparent')).toBeNull();
    expect(parseTraceparent('00-abc-def-01')).toBeNull();
  });

  it('returns null when trace_id is all zeros (invalid per W3C spec)', () => {
    const traceparent = `00-${'0'.repeat(32)}-b7ad6b7169203331-01`;
    expect(parseTraceparent(traceparent)).toBeNull();
  });

  it('rejects uppercase hex (spec forbids it)', () => {
    const traceparent = '00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01';
    expect(parseTraceparent(traceparent)).toBeNull();
  });
});

describe('resolveCorrelationId', () => {
  it('prefers traceparent over x-correlation-id', () => {
    const id = resolveCorrelationId({
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      correlationId: 'should-be-ignored',
    });
    expect(id).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('falls back to x-correlation-id when traceparent is malformed', () => {
    const id = resolveCorrelationId({
      traceparent: 'garbage',
      correlationId: 'corr-123',
    });
    expect(id).toBe('corr-123');
  });

  it('falls back to x-correlation-id when traceparent is missing', () => {
    expect(resolveCorrelationId({ correlationId: 'corr-456' })).toBe('corr-456');
  });

  it('generates a UUID when neither header is present', () => {
    const id = resolveCorrelationId({});
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('generates a UUID when correlation-id is whitespace only', () => {
    const id = resolveCorrelationId({ correlationId: '   ' });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('takes the first entry of array-valued headers', () => {
    const id = resolveCorrelationId({
      traceparent: [
        '00-11111111111111111111111111111111-2222222222222222-01',
        '00-99999999999999999999999999999999-8888888888888888-01',
      ],
    });
    expect(id).toBe('11111111111111111111111111111111');
  });

  it('produces distinct ids on successive empty calls', () => {
    const a = resolveCorrelationId({});
    const b = resolveCorrelationId({});
    expect(a).not.toBe(b);
  });
});
