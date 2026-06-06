import { Test, TestingModule } from '@nestjs/testing';
import { RedactionService } from './redaction.service';

describe('RedactionService', () => {
  let service: RedactionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RedactionService],
    }).compile();

    service = module.get(RedactionService);
  });

  describe('scrubString', () => {
    it('returns the original input unchanged when no patterns match', () => {
      const result = service.scrubString('The collection screen crashes on startup.');

      expect(result).toEqual({ value: 'The collection screen crashes on startup.', mutated: false });
    });

    it('redacts email addresses', () => {
      const result = service.scrubString('My account is alice@example.com');

      expect(result.value).toBe('My account is [REDACTED:email]');
      expect(result.mutated).toBe(true);
    });

    it('redacts bearer tokens (case-insensitive)', () => {
      const result = service.scrubString('Authorization: Bearer abc.def-123');

      expect(result.value).toBe('Authorization: [REDACTED:bearer]');
      expect(result.mutated).toBe(true);
    });

    it('redacts long opaque hex blobs', () => {
      const sessionId = 'a'.repeat(40);
      const result = service.scrubString(`session=${sessionId}; other=value`);

      expect(result.value).toBe('session=[REDACTED:hex]; other=value');
      expect(result.mutated).toBe(true);
    });

    it('redacts JWT-shaped tokens', () => {
      const result = service.scrubString('token=eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM');

      expect(result.value).toContain('[REDACTED:jwt]');
      expect(result.mutated).toBe(true);
    });

    it('redacts multiple distinct patterns in a single pass', () => {
      const result = service.scrubString('Email me at bob@x.io or Bearer xyz123');

      expect(result.value).toBe('Email me at [REDACTED:email] or [REDACTED:bearer]');
      expect(result.mutated).toBe(true);
    });
  });

  describe('scrubObject', () => {
    it('returns null when input is null or undefined', () => {
      expect(service.scrubObject(null)).toEqual({ value: null, mutated: false });
      expect(service.scrubObject(undefined)).toEqual({ value: null, mutated: false });
    });

    it('redacts values under known sensitive keys', () => {
      const result = service.scrubObject({
        os: 'Android 14',
        authToken: 'secret-shouldnt-leak',
        password: 'hunter2',
      });

      expect(result.value).toEqual({
        os: 'Android 14',
        authToken: '[REDACTED:key]',
        password: '[REDACTED:key]',
      });
      expect(result.mutated).toBe(true);
    });

    it('matches sensitive keys case-insensitively', () => {
      const result = service.scrubObject({ AuthToken: 'x', SESSIONID: 'y' });

      expect(result.value).toEqual({ AuthToken: '[REDACTED:key]', SESSIONID: '[REDACTED:key]' });
    });

    it('recurses into nested objects', () => {
      const result = service.scrubObject({
        device: { model: 'Pixel 8', cookie: 'leaky-cookie' },
        nested: { deeper: { secret: 'classified' } },
      });

      expect(result.value).toEqual({
        device: { model: 'Pixel 8', cookie: '[REDACTED:key]' },
        nested: { deeper: { secret: '[REDACTED:key]' } },
      });
      expect(result.mutated).toBe(true);
    });

    it('recurses into arrays', () => {
      const result = service.scrubObject({
        contacts: [{ email: 'alice@example.com' }, { email: 'bob@example.com' }],
      });

      expect(result.value).toEqual({
        contacts: [{ email: '[REDACTED:email]' }, { email: '[REDACTED:email]' }],
      });
      expect(result.mutated).toBe(true);
    });

    it('scrubs content patterns in string leaves even when keys are benign', () => {
      const result = service.scrubObject({ note: 'Contact alice@example.com please' });

      expect(result.value).toEqual({ note: 'Contact [REDACTED:email] please' });
      expect(result.mutated).toBe(true);
    });

    it('returns mutated=false when nothing was scrubbed', () => {
      const result = service.scrubObject({ os: 'Android', model: 'Pixel' });

      expect(result.value).toEqual({ os: 'Android', model: 'Pixel' });
      expect(result.mutated).toBe(false);
    });

    it('does not mutate the original object', () => {
      const input = { authToken: 'x', nested: { password: 'y' } };
      const snapshot = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;

      service.scrubObject(input);

      expect(input).toEqual(snapshot);
    });
  });
});
