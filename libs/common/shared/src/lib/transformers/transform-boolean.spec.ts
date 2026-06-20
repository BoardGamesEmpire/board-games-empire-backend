import { plainToInstance } from 'class-transformer';
import { TransformBoolean } from './transform-boolean';

class Sample {
  @TransformBoolean()
  flag?: boolean;

  @TransformBoolean()
  withDefault?: boolean = true;
}

describe('TransformBoolean', () => {
  // Mirror the global ValidationPipe options (apps/api/src/main.ts). Implicit
  // conversion is exactly what would break a naive boolean transform, so the
  // decorator must be proven correct with it enabled.
  const toSample = (plain: Record<string, unknown>): Sample =>
    plainToInstance(Sample, plain, { enableImplicitConversion: true });

  it('leaves the value undefined when the key is absent', () => {
    expect(toSample({}).flag).toBeUndefined();
  });

  it("parses the string 'false' as false (not Boolean('false') === true)", () => {
    expect(toSample({ flag: 'false' }).flag).toBe(false);
  });

  it("parses the string 'true' as true", () => {
    expect(toSample({ flag: 'true' }).flag).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(toSample({ flag: 'TRUE' }).flag).toBe(true);
    expect(toSample({ flag: 'False' }).flag).toBe(false);
  });

  it("treats any other present string as false", () => {
    expect(toSample({ flag: 'yes' }).flag).toBe(false);
    expect(toSample({ flag: '1' }).flag).toBe(false);
    expect(toSample({ flag: '' }).flag).toBe(false);
  });

  it('passes real booleans through (JSON body case)', () => {
    expect(toSample({ flag: true }).flag).toBe(true);
    expect(toSample({ flag: false }).flag).toBe(false);
  });

  it('preserves a class default when the key is absent', () => {
    expect(toSample({}).withDefault).toBe(true);
  });

  it('overrides a class default when the value is present', () => {
    expect(toSample({ withDefault: 'false' }).withDefault).toBe(false);
  });
});
