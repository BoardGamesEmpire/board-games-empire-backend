import { plainToInstance } from 'class-transformer';
import { TransformAsSent, TransformTrimmedAsSent } from './transform-as-sent';

class Sample {
  @TransformAsSent()
  count?: unknown;

  @TransformAsSent()
  flag?: boolean;

  @TransformTrimmedAsSent()
  name?: unknown;
}

describe('TransformAsSent and TransformTrimmedAsSent (#1418)', () => {
  // Mirror the global ValidationPipe options (apps/api/src/main.ts), whose
  // implicit conversion is what these decorators undo.
  const toSample = (plain: Record<string, unknown>): Sample =>
    plainToInstance(Sample, plain, { enableImplicitConversion: true });

  it('keeps a value as the request sent it, so the wrong kind fails its validator (#1418)', () => {
    expect(toSample({ count: '90' }).count).toBe('90');
    expect(toSample({ count: 5 }).count).toBe(5);
    expect(toSample({ flag: 'false' }).flag).toBe('false');
  });

  it('passes null and an absent key through unchanged (#1418)', () => {
    expect(toSample({ count: null }).count).toBeNull();
    expect(toSample({}).count).toBeUndefined();
  });

  it('trims a string read as sent, and leaves a number a number for IsString to refuse (#1418)', () => {
    expect(toSample({ name: '  My key \n' }).name).toBe('My key');
    expect(toSample({ name: '   ' }).name).toBe('');
    expect(toSample({ name: 5 }).name).toBe(5);
    expect(toSample({ name: null }).name).toBeNull();
  });
});
