import { plainToInstance } from 'class-transformer';
import { TransformTrim } from './transform-trim';

class Sample {
  @TransformTrim()
  name?: unknown;
}

describe('TransformTrim (#1241)', () => {
  // Mirror the global ValidationPipe options (apps/api/src/main.ts).
  const toSample = (plain: Record<string, unknown>): Sample =>
    plainToInstance(Sample, plain, { enableImplicitConversion: true });

  it('trims surrounding whitespace, and leaves a blank string empty for IsNotEmpty to refuse (#1241)', () => {
    expect(toSample({ name: '  Top 100 \n' }).name).toBe('Top 100');
    expect(toSample({ name: '   ' }).name).toBe('');
  });

  it('passes null, an absent key and a non-string through unchanged (#1241)', () => {
    expect(toSample({ name: null }).name).toBeNull();
    expect(toSample({}).name).toBeUndefined();
    expect(toSample({ name: 5 }).name).toBe(5);
  });
});
