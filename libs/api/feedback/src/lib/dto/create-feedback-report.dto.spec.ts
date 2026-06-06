import { FeedbackCategory, FeedbackContext, FeedbackSeverity } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import {
  FEEDBACK_MAX_CORRELATION_KEY_LENGTH,
  FEEDBACK_MAX_MESSAGE_LENGTH,
  FEEDBACK_MAX_REDACTED_FIELDS,
  FEEDBACK_MAX_TITLE_LENGTH,
} from './../constants/feedback.constants';
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

type PlainPayload = Record<string, unknown>;

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
});
