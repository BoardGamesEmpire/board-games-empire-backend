import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import 'reflect-metadata';

import { MaxJsonBytes } from './max-json-bytes.validator';

/**
 * Exercises `@MaxJsonBytes` directly through a throwaway harness class.
 * The breadcrumbs DTO spec covers the integrated case (nested validation
 * + DTO context); this spec proves the decorator's own metric is correct
 * in isolation, especially the multi-byte character handling that motivated
 * choosing UTF-8 bytes over `.length`.
 */

const CAP = 1_024;

class Harness {
  @MaxJsonBytes(CAP)
  payload?: unknown;
}

type PlainPayload = Record<string, unknown>;

async function validatePayload(payload: PlainPayload): Promise<ValidationError[]> {
  const dto = plainToInstance(Harness, payload);

  return validate(dto);
}

function hasErrorFor(errors: ValidationError[], property: string): boolean {
  return errors.some((error) => error.property === property);
}

describe('@MaxJsonBytes', () => {
  describe('absent values', () => {
    it('accepts an undefined value', async () => {
      const errors = await validatePayload({});

      expect(hasErrorFor(errors, 'payload')).toBe(false);
    });

    it('accepts an explicit null value', async () => {
      const errors = await validatePayload({ payload: null });

      expect(hasErrorFor(errors, 'payload')).toBe(false);
    });
  });

  describe('byte size enforcement', () => {
    it('accepts a payload whose serialized size sits at the cap', async () => {
      // Pad an array until adding one more entry would cross the cap.
      const entries: string[] = [];
      const filler = 'x'.repeat(16);

      while (Buffer.byteLength(JSON.stringify([...entries, filler]), 'utf8') <= CAP) {
        entries.push(filler);
      }

      const errors = await validatePayload({ payload: entries });

      expect(hasErrorFor(errors, 'payload')).toBe(false);
    });

    it('rejects a payload whose serialized size exceeds the cap', async () => {
      const entries: string[] = [];
      const filler = 'x'.repeat(16);

      while (Buffer.byteLength(JSON.stringify(entries), 'utf8') <= CAP) {
        entries.push(filler);
      }

      const errors = await validatePayload({ payload: entries });

      expect(hasErrorFor(errors, 'payload')).toBe(true);
    });
  });

  describe('multi-byte characters', () => {
    it('counts 4-byte UTF-8 characters as 4 bytes, not 1', async () => {
      // 1 user-perceived char ('😀') = 2 JS code units = 4 UTF-8 bytes.
      // Build a single-string payload calibrated to be small in .length
      // and large in bytes.
      const emojiCount = Math.ceil(CAP / 2);
      const message = '😀'.repeat(emojiCount);
      const serialized = JSON.stringify(message);

      // Precondition: this payload would pass a naive `.length` check
      // (string is shorter than the cap as JS code units) but fail the
      // byte check (multi-byte chars double the size).
      expect(serialized.length).toBeLessThan(CAP * 2);
      expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(CAP);

      const errors = await validatePayload({ payload: message });

      expect(hasErrorFor(errors, 'payload')).toBe(true);
    });

    it('counts 2-byte UTF-8 characters as 2 bytes', async () => {
      // 'é' is 1 char in JS, 2 bytes in UTF-8.
      const chars = Math.ceil(CAP / 2) + 16; // a little over the cap in bytes
      const message = 'é'.repeat(chars);

      const errors = await validatePayload({ payload: message });

      expect(hasErrorFor(errors, 'payload')).toBe(true);
    });
  });

  describe('non-serializable values', () => {
    it('rejects a value containing a BigInt (not JSON-representable)', async () => {
      // JSON.stringify throws on BigInt — the validator must surface that
      // as a validation failure rather than letting the exception escape.
      const errors = await validatePayload({ payload: { count: BigInt(1) } });

      expect(hasErrorFor(errors, 'payload')).toBe(true);
    });

    it('rejects a value containing a circular reference', async () => {
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;

      // Bypass plainToInstance — class-transformer deep-walks values to
      // apply transformations and recurses forever on circular structures,
      // throwing before the validator runs. Construct the harness directly:
      // class-validator's own traversal stops at decorated properties (no
      // recursion into the value), so MaxJsonBytesConstraint gets called
      // and its try/catch around JSON.stringify catches the TypeError as
      // designed.
      const harness = new Harness();
      harness.payload = circular;

      const errors = await validate(harness);

      expect(hasErrorFor(errors, 'payload')).toBe(true);
    });
  });
});
