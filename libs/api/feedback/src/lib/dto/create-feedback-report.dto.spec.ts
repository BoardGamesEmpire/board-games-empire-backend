import { FeedbackCategory, FeedbackContext, FeedbackSeverity } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { FEEDBACK_BREADCRUMBS_MAX_BYTES, FEEDBACK_MAX_STACK_TRACE_LENGTH } from '../constants/feedback.constants';
import {
  FEEDBACK_MAX_CORRELATION_KEY_LENGTH,
  FEEDBACK_MAX_MESSAGE_LENGTH,
  FEEDBACK_MAX_REDACTED_FIELDS,
  FEEDBACK_MAX_TITLE_LENGTH,
} from './../constants/feedback.constants';
import { BreadcrumbLogLevel } from './breadcrumb.dto';
import { CreateFeedbackReportDto } from './create-feedback-report.dto';

const VALID_BUG_PAYLOAD = {
  category: FeedbackCategory.Bug,
  message: 'Collection screen crashes when adding a game with no cover art.',
  severity: FeedbackSeverity.Medium,
} as const;

const VALID_FEATURE_REQUEST = {
  category: FeedbackCategory.FeatureRequest,
  message: 'Allow exporting collection as CSV.',
} as const;

const VALID_PAYLOAD: PlainPayload = {
  category: FeedbackCategory.Crash,
  message: 'Crash when adding a coverless game to the collection.',
};

type PlainPayload = Record<string, unknown>;

/** Convenience type for assembling valid-shaped fixtures. */
interface BreadcrumbInput {
  timestamp: string;
  level: BreadcrumbLogLevel;
  loggerName: string;
  message: string;
  sanitizedContext?: Record<string, unknown> | null;
}

function breadcrumb(overrides: Partial<BreadcrumbInput> = {}): BreadcrumbInput {
  return {
    timestamp: '2026-06-13T10:00:00.000Z',
    level: BreadcrumbLogLevel.Info,
    loggerName: 'bge.storage.sync_queue',
    message: 'queued draft report 1f3a',
    ...overrides,
  };
}
/** Loose-typed helper for invalid-payload cases (deliberately Record). */
function rawBreadcrumb(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...breadcrumb(), ...overrides };
}

async function validatePayload(payload: PlainPayload): Promise<ValidationError[]> {
  const dto = plainToInstance(CreateFeedbackReportDto, payload);

  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

function hasErrorFor(errors: ValidationError[], property: string): boolean {
  return errors.some((error) => error.property === property);
}

describe('CreateFeedbackReportDto', () => {
  describe('category (required)', () => {
    it('accepts each valid category', async () => {
      for (const category of [FeedbackCategory.Crash, FeedbackCategory.Bug, FeedbackCategory.FeatureRequest]) {
        const errors = await validatePayload({
          category,
          message: 'sample',
          ...(category !== FeedbackCategory.FeatureRequest ? { severity: FeedbackSeverity.Low } : {}),
        });

        expect(hasErrorFor(errors, 'category')).toBe(false);
      }
    });

    it('rejects a missing category', async () => {
      const errors = await validatePayload({ message: 'sample' });

      expect(hasErrorFor(errors, 'category')).toBe(true);
    });

    it('rejects an unknown category value', async () => {
      const errors = await validatePayload({ category: 'Praise', message: 'sample' });

      expect(hasErrorFor(errors, 'category')).toBe(true);
    });
  });

  describe('message (required)', () => {
    it('accepts a well-formed message', async () => {
      const errors = await validatePayload({ ...VALID_BUG_PAYLOAD });

      expect(errors).toHaveLength(0);
    });

    it('rejects a missing or empty message', async () => {
      for (const payload of [
        { ...VALID_BUG_PAYLOAD, message: undefined },
        { ...VALID_BUG_PAYLOAD, message: '' },
      ]) {
        const errors = await validatePayload(payload);

        expect(hasErrorFor(errors, 'message')).toBe(true);
      }
    });

    it('rejects a message that exceeds the field length cap', async () => {
      const errors = await validatePayload({
        ...VALID_BUG_PAYLOAD,
        message: 'x'.repeat(FEEDBACK_MAX_MESSAGE_LENGTH + 1),
      });

      expect(hasErrorFor(errors, 'message')).toBe(true);
    });

    it('accepts a message at the upper length boundary', async () => {
      const errors = await validatePayload({ ...VALID_BUG_PAYLOAD, message: 'x'.repeat(FEEDBACK_MAX_MESSAGE_LENGTH) });

      expect(hasErrorFor(errors, 'message')).toBe(false);
    });
  });

  describe('severity (category-conditional)', () => {
    it('requires severity when category is Crash', async () => {
      const errors = await validatePayload({ category: FeedbackCategory.Crash, message: 'crash' });

      expect(hasErrorFor(errors, 'severity')).toBe(true);
    });

    it('requires severity when category is Bug', async () => {
      const errors = await validatePayload({ category: FeedbackCategory.Bug, message: 'bug' });

      expect(hasErrorFor(errors, 'severity')).toBe(true);
    });

    it('does NOT require severity for FeatureRequest', async () => {
      const errors = await validatePayload({ ...VALID_FEATURE_REQUEST });

      expect(hasErrorFor(errors, 'severity')).toBe(false);
    });

    it('rejects a non-enum severity value', async () => {
      const errors = await validatePayload({ ...VALID_BUG_PAYLOAD, severity: 'Apocalyptic' });

      expect(hasErrorFor(errors, 'severity')).toBe(true);
    });
  });

  describe('context (optional, enum)', () => {
    it('accepts each valid context', async () => {
      for (const context of [FeedbackContext.Client, FeedbackContext.Server, FeedbackContext.Unknown]) {
        const errors = await validatePayload({ ...VALID_BUG_PAYLOAD, context });

        expect(hasErrorFor(errors, 'context')).toBe(false);
      }
    });

    it('rejects an unknown context value', async () => {
      const errors = await validatePayload({ ...VALID_BUG_PAYLOAD, context: 'Mobile' });

      expect(hasErrorFor(errors, 'context')).toBe(true);
    });
  });

  describe('title (optional)', () => {
    it('rejects a title that exceeds the cap', async () => {
      const errors = await validatePayload({ ...VALID_BUG_PAYLOAD, title: 'x'.repeat(FEEDBACK_MAX_TITLE_LENGTH + 1) });

      expect(hasErrorFor(errors, 'title')).toBe(true);
    });
  });

  describe('userRedactedFields (optional)', () => {
    it('accepts an array of string field paths', async () => {
      const errors = await validatePayload({
        ...VALID_BUG_PAYLOAD,
        userRedactedFields: ['email', 'deviceInfo.serial'],
      });

      expect(errors).toHaveLength(0);
    });

    it('rejects a non-array value', async () => {
      const errors = await validatePayload({ ...VALID_BUG_PAYLOAD, userRedactedFields: 'email' });

      expect(hasErrorFor(errors, 'userRedactedFields')).toBe(true);
    });

    it('rejects entries that are not strings', async () => {
      const errors = await validatePayload({ ...VALID_BUG_PAYLOAD, userRedactedFields: ['email', 7] });

      expect(hasErrorFor(errors, 'userRedactedFields')).toBe(true);
    });

    it('rejects more than the array-size cap', async () => {
      const errors = await validatePayload({
        ...VALID_BUG_PAYLOAD,
        userRedactedFields: Array.from({ length: FEEDBACK_MAX_REDACTED_FIELDS + 1 }, (_, i) => `field${i}`),
      });

      expect(hasErrorFor(errors, 'userRedactedFields')).toBe(true);
    });
  });

  describe('correlationKey (optional)', () => {
    it('accepts a string key', async () => {
      const errors = await validatePayload({ ...VALID_BUG_PAYLOAD, correlationKey: 'client-retry-abc123' });

      expect(errors).toHaveLength(0);
    });

    it('rejects a key exceeding the length cap', async () => {
      const errors = await validatePayload({
        ...VALID_BUG_PAYLOAD,
        correlationKey: 'x'.repeat(FEEDBACK_MAX_CORRELATION_KEY_LENGTH + 1),
      });

      expect(hasErrorFor(errors, 'correlationKey')).toBe(true);
    });
  });

  describe('deviceInfo (optional)', () => {
    it('accepts a plain object', async () => {
      const errors = await validatePayload({
        ...VALID_BUG_PAYLOAD,
        deviceInfo: { os: 'Android 14', model: 'Pixel 8' },
      });

      expect(errors).toHaveLength(0);
    });

    it('rejects a non-object value', async () => {
      const errors = await validatePayload({ ...VALID_BUG_PAYLOAD, deviceInfo: 'Android 14' });

      expect(hasErrorFor(errors, 'deviceInfo')).toBe(true);
    });
  });

  describe('unknown fields', () => {
    it('rejects properties not declared on the DTO (forbidNonWhitelisted)', async () => {
      const errors = await validatePayload({ ...VALID_BUG_PAYLOAD, status: 'Resolved' });

      expect(hasErrorFor(errors, 'status')).toBe(true);
    });
  });

  describe('stackTrace', () => {
    it('accepts a payload with no stackTrace (field is optional)', async () => {
      const errors = await validatePayload({ ...VALID_PAYLOAD });

      expect(hasErrorFor(errors, 'stackTrace')).toBe(false);
    });

    it('accepts a well-formed stack trace', async () => {
      const stackTrace = [
        'TypeError: undefined is not a function',
        '    at CollectionScreen.onAdd (Collection.tsx:117:12)',
        '    at ReactFiber.beginWork (react-dom.js:14322:5)',
      ].join('\n');

      const errors = await validatePayload({ ...VALID_PAYLOAD, stackTrace });

      expect(hasErrorFor(errors, 'stackTrace')).toBe(false);
    });

    it('accepts a stack trace at the upper length boundary', async () => {
      const stackTrace = 'x'.repeat(FEEDBACK_MAX_STACK_TRACE_LENGTH);

      const errors = await validatePayload({ ...VALID_PAYLOAD, stackTrace });

      expect(hasErrorFor(errors, 'stackTrace')).toBe(false);
    });

    it('rejects a stack trace that exceeds the length cap', async () => {
      const stackTrace = 'x'.repeat(FEEDBACK_MAX_STACK_TRACE_LENGTH + 1);

      const errors = await validatePayload({ ...VALID_PAYLOAD, stackTrace });

      expect(hasErrorFor(errors, 'stackTrace')).toBe(true);
    });

    it('rejects an empty stackTrace (use omission to signal "no trace")', async () => {
      const errors = await validatePayload({ ...VALID_PAYLOAD, stackTrace: '' });

      expect(hasErrorFor(errors, 'stackTrace')).toBe(true);
    });

    it('rejects a non-string stackTrace', async () => {
      const errors = await validatePayload({ ...VALID_PAYLOAD, stackTrace: 42 });

      expect(hasErrorFor(errors, 'stackTrace')).toBe(true);
    });
  });

  describe('breadcrumbs', () => {
    describe('array-level', () => {
      it('accepts a payload with no breadcrumbs (field is optional)', async () => {
        const errors = await validatePayload({ ...VALID_PAYLOAD });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(false);
      });

      it('accepts an empty breadcrumbs array', async () => {
        const errors = await validatePayload({ ...VALID_PAYLOAD, breadcrumbs: [] });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(false);
      });

      it('accepts a well-formed array of mixed-level entries', async () => {
        const breadcrumbs: ReadonlyArray<BreadcrumbInput> = [
          breadcrumb({ level: BreadcrumbLogLevel.Info, message: 'Opened /collection' }),
          breadcrumb({
            level: BreadcrumbLogLevel.Debug,
            loggerName: 'bge.api.client',
            message: 'GET /api/games/123 -> 200',
            sanitizedContext: { gameId: 'g-123', durationMs: 142 },
          }),
          breadcrumb({ level: BreadcrumbLogLevel.Error, message: 'TypeError: undefined is not a function' }),
        ];

        const errors = await validatePayload({ ...VALID_PAYLOAD, breadcrumbs });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(false);
      });

      it('rejects a non-array breadcrumbs payload', async () => {
        const errors = await validatePayload({
          ...VALID_PAYLOAD,
          breadcrumbs: { not: 'an array' },
        });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(true);
      });

      it('rejects entries that are not objects', async () => {
        const errors = await validatePayload({
          ...VALID_PAYLOAD,
          breadcrumbs: ['just a string', 42, null, true],
        });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(true);
      });
    });

    describe('per-entry shape (mirrors client Breadcrumb)', () => {
      it('rejects an entry missing timestamp', async () => {
        const entry = rawBreadcrumb();
        delete entry['timestamp'];

        const errors = await validatePayload({ ...VALID_PAYLOAD, breadcrumbs: [entry] });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(true);
      });

      it('rejects an entry whose timestamp is not ISO 8601', async () => {
        const errors = await validatePayload({
          ...VALID_PAYLOAD,
          breadcrumbs: [rawBreadcrumb({ timestamp: 'last Tuesday' })],
        });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(true);
      });

      it('rejects an entry missing level', async () => {
        const entry = rawBreadcrumb();
        delete entry['level'];

        const errors = await validatePayload({ ...VALID_PAYLOAD, breadcrumbs: [entry] });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(true);
      });

      it('rejects an unknown level wire value', async () => {
        const errors = await validatePayload({
          ...VALID_PAYLOAD,
          breadcrumbs: [rawBreadcrumb({ level: 'trace' })],
        });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(true);
      });

      it('rejects a level given in PascalCase (client wire is camelCase)', async () => {
        const errors = await validatePayload({
          ...VALID_PAYLOAD,
          breadcrumbs: [rawBreadcrumb({ level: 'Info' })],
        });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(true);
      });

      it('accepts every defined level wire value', async () => {
        const breadcrumbs: ReadonlyArray<BreadcrumbInput> = Object.values(BreadcrumbLogLevel).map((level) =>
          breadcrumb({ level }),
        );

        const errors = await validatePayload({ ...VALID_PAYLOAD, breadcrumbs });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(false);
      });

      it('rejects an entry missing loggerName', async () => {
        const entry = rawBreadcrumb();
        delete entry['loggerName'];

        const errors = await validatePayload({ ...VALID_PAYLOAD, breadcrumbs: [entry] });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(true);
      });

      it('rejects a non-string loggerName', async () => {
        const errors = await validatePayload({
          ...VALID_PAYLOAD,
          breadcrumbs: [rawBreadcrumb({ loggerName: 42 })],
        });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(true);
      });

      it('rejects an entry missing message', async () => {
        const entry = rawBreadcrumb();
        delete entry['message'];

        const errors = await validatePayload({ ...VALID_PAYLOAD, breadcrumbs: [entry] });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(true);
      });

      it('rejects a non-string message', async () => {
        const errors = await validatePayload({
          ...VALID_PAYLOAD,
          breadcrumbs: [rawBreadcrumb({ message: 42 })],
        });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(true);
      });

      it("accepts the client's rawMapMessagePlaceholder verbatim", async () => {
        // Client substitutes '<context map>' when the log payload was a raw
        // Map (see Breadcrumb.rawMapMessagePlaceholder). The backend must not
        // treat angle-bracketed strings as suspicious.
        const errors = await validatePayload({
          ...VALID_PAYLOAD,
          breadcrumbs: [breadcrumb({ message: '<context map>' })],
        });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(false);
      });

      it('accepts an entry omitting sanitizedContext', async () => {
        const errors = await validatePayload({
          ...VALID_PAYLOAD,
          breadcrumbs: [breadcrumb()],
        });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(false);
      });

      it('accepts an entry with explicit null sanitizedContext (Dart nullable wire form)', async () => {
        const errors = await validatePayload({
          ...VALID_PAYLOAD,
          breadcrumbs: [breadcrumb({ sanitizedContext: null })],
        });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(false);
      });

      it('rejects a non-object sanitizedContext', async () => {
        const errors = await validatePayload({
          ...VALID_PAYLOAD,
          breadcrumbs: [rawBreadcrumb({ sanitizedContext: 'not an object' })],
        });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(true);
      });

      it('rejects an array-valued sanitizedContext', async () => {
        const errors = await validatePayload({
          ...VALID_PAYLOAD,
          breadcrumbs: [rawBreadcrumb({ sanitizedContext: ['a', 'b'] })],
        });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(true);
      });

      it('rejects entries carrying unknown extra fields (drift catch)', async () => {
        const errors = await validatePayload({
          ...VALID_PAYLOAD,
          breadcrumbs: [rawBreadcrumb({ undocumentedField: 'oops' })],
        });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(true);
      });
    });

    describe('UTF-8 byte size cap', () => {
      it('accepts a breadcrumbs array whose serialized byte size sits at the cap', async () => {
        const entries: BreadcrumbInput[] = [];

        while (
          Buffer.byteLength(JSON.stringify([...entries, breadcrumb()]), 'utf8') <= FEEDBACK_BREADCRUMBS_MAX_BYTES
        ) {
          entries.push(breadcrumb());
        }
        // entries is the largest set that still fits.

        const errors = await validatePayload({ ...VALID_PAYLOAD, breadcrumbs: entries });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(false);
      });

      it('rejects a breadcrumbs array whose serialized byte size exceeds the cap', async () => {
        const padding = 'x'.repeat(2_048);
        const entries: BreadcrumbInput[] = [];

        while (Buffer.byteLength(JSON.stringify(entries), 'utf8') <= FEEDBACK_BREADCRUMBS_MAX_BYTES) {
          entries.push(breadcrumb({ message: padding }));
        }

        const errors = await validatePayload({ ...VALID_PAYLOAD, breadcrumbs: entries });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(true);
      });

      it('measures size as UTF-8 bytes, not JS string .length (4-byte chars count multiply)', async () => {
        // '😀' is 1 user-perceived char but 2 JS code units and 4 UTF-8 bytes.
        // Build a payload where JSON.stringify(...).length sits comfortably
        // below the cap while Buffer.byteLength exceeds it. Any implementation
        // measuring by .length will erroneously accept; one measuring by
        // UTF-8 bytes correctly rejects.
        const entries: BreadcrumbInput[] = [];

        // Use 4-byte chars to push byte size up far faster than .length.
        while (true) {
          const candidate = [...entries, breadcrumb({ message: '😀'.repeat(1_024) })];
          const serialized = JSON.stringify(candidate);
          const byteSize = Buffer.byteLength(serialized, 'utf8');

          if (serialized.length >= FEEDBACK_BREADCRUMBS_MAX_BYTES) break; // safety
          entries.push(candidate[candidate.length - 1]!);

          if (byteSize > FEEDBACK_BREADCRUMBS_MAX_BYTES + 4_096) break; // far enough over
        }

        const serialized = JSON.stringify(entries);

        // Precondition: this payload is exactly the kind a naive .length
        // check would accept but a byte check rejects.
        expect(serialized.length).toBeLessThan(FEEDBACK_BREADCRUMBS_MAX_BYTES);
        expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(FEEDBACK_BREADCRUMBS_MAX_BYTES);

        const errors = await validatePayload({ ...VALID_PAYLOAD, breadcrumbs: entries });

        expect(hasErrorFor(errors, 'breadcrumbs')).toBe(true);
      });
    });
  });
});
