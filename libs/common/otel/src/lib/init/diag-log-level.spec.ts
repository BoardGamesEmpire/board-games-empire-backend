import { DiagLogLevel } from '@opentelemetry/api';
import { OTEL_LOG_LEVEL_ENV, resolveDiagLogLevel } from './diag-log-level';

describe('resolveDiagLogLevel', () => {
  describe('unset env var', () => {
    it('returns INFO when OTEL_LOG_LEVEL is unset', () => {
      const env: NodeJS.ProcessEnv = {};

      expect(resolveDiagLogLevel(env)).toBe(DiagLogLevel.INFO);
    });

    it('returns INFO when OTEL_LOG_LEVEL is an empty string', () => {
      const env: NodeJS.ProcessEnv = { [OTEL_LOG_LEVEL_ENV]: '' };

      expect(resolveDiagLogLevel(env)).toBe(DiagLogLevel.INFO);
    });
  });

  describe('recognized values', () => {
    it.each<[string, DiagLogLevel]>([
      ['none', DiagLogLevel.NONE],
      ['error', DiagLogLevel.ERROR],
      ['warn', DiagLogLevel.WARN],
      ['info', DiagLogLevel.INFO],
      ['debug', DiagLogLevel.DEBUG],
      ['verbose', DiagLogLevel.VERBOSE],
      ['all', DiagLogLevel.ALL],
    ])('maps "%s" to the corresponding DiagLogLevel', (value, expected) => {
      const env: NodeJS.ProcessEnv = { [OTEL_LOG_LEVEL_ENV]: value };

      expect(resolveDiagLogLevel(env)).toBe(expected);
    });

    it.each<[string, DiagLogLevel]>([
      ['DEBUG', DiagLogLevel.DEBUG],
      ['Verbose', DiagLogLevel.VERBOSE],
      ['ERROR', DiagLogLevel.ERROR],
    ])('is case-insensitive for "%s"', (value, expected) => {
      const env: NodeJS.ProcessEnv = { [OTEL_LOG_LEVEL_ENV]: value };

      expect(resolveDiagLogLevel(env)).toBe(expected);
    });
  });

  describe('unrecognized values', () => {
    it('falls back to INFO for typos (rather than throwing)', () => {
      const env: NodeJS.ProcessEnv = { [OTEL_LOG_LEVEL_ENV]: '  ' };

      expect(resolveDiagLogLevel(env)).toBe(DiagLogLevel.INFO);
    });

    it('falls back to INFO for arbitrary garbage', () => {
      const env: NodeJS.ProcessEnv = { [OTEL_LOG_LEVEL_ENV]: 'shrug' };

      expect(resolveDiagLogLevel(env)).toBe(DiagLogLevel.INFO);
    });
  });

  describe('defaults to process.env', () => {
    it('reads from process.env when no argument is given', () => {
      const original = process.env[OTEL_LOG_LEVEL_ENV];
      delete process.env[OTEL_LOG_LEVEL_ENV];

      try {
        expect(resolveDiagLogLevel()).toBe(DiagLogLevel.INFO);
      } finally {
        if (original === undefined) {
          delete process.env[OTEL_LOG_LEVEL_ENV];
        } else {
          process.env[OTEL_LOG_LEVEL_ENV] = original;
        }
      }
    });
  });
});
