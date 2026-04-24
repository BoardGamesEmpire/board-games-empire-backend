import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DateTime } from 'luxon';
import { SecurityTxtService } from './security-txt.service';

const ISSUER = 'https://api.example.com';
const FIXED_NOW = DateTime.now().toUTC().endOf('day').toJSDate();
const FIXED_EXPIRES = DateTime.now().toUTC().plus({ years: 1 }).startOf('day').toISO();

interface MockSecurityConfig {
  contact?: string[];
  expires?: string;
  policy?: string;
  encryption?: string;
  acknowledgments?: string;
  preferredLanguages?: string;
  hiring?: string;
}

function buildMockConfigService(config: MockSecurityConfig): jest.Mocked<Pick<ConfigService, 'get'>> {
  const configMap: Record<string, unknown> = {
    'security.contact': config.contact ?? [],
    'security.expires': config.expires ?? '',
    'security.policy': config.policy ?? '',
    'security.encryption': config.encryption ?? '',
    'security.acknowledgments': config.acknowledgments ?? '',
    'security.preferredLanguages': config.preferredLanguages ?? 'en',
    'security.hiring': config.hiring ?? '',
  };

  return {
    get: jest.fn().mockImplementation(<T>(key: string) => configMap[key] as T),
  };
}

async function createService(config: MockSecurityConfig): Promise<SecurityTxtService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [SecurityTxtService, { provide: ConfigService, useValue: buildMockConfigService(config) }],
  }).compile();

  return module.get(SecurityTxtService);
}

describe('SecurityTxtService', () => {
  describe('isConfigured()', () => {
    it('returns false when no contact addresses are set', async () => {
      const service = await createService({ contact: [] });
      expect(service.isConfigured()).toBe(false);
    });

    it('returns true when at least one contact address is set', async () => {
      const service = await createService({ contact: ['mailto:security@example.com'] });
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('build()', () => {
    describe('when no contact is configured', () => {
      it('returns null', async () => {
        const service = await createService({ contact: [] });
        expect(service.build(ISSUER, FIXED_NOW)).toBeNull();
      });
    });

    describe('required fields', () => {
      it('includes a Contact line for each configured address', async () => {
        const service = await createService({
          contact: ['mailto:security@example.com', 'https://example.com/security'],
        });

        const output = service.build(ISSUER, FIXED_NOW)!;

        expect(output).toContain('Contact: mailto:security@example.com');
        expect(output).toContain('Contact: https://example.com/security');
      });

      it('includes the Expires field', async () => {
        const service = await createService({ contact: ['mailto:security@example.com'] });
        const output = service.build(ISSUER, FIXED_NOW)!;

        expect(output).toMatch(/^Expires: .+/m);
      });

      it('uses the explicit SECURITY_EXPIRES value when set', async () => {
        const explicit = '2027-01-01T00:00:00.000Z';
        const service = await createService({
          contact: ['mailto:security@example.com'],
          expires: explicit,
        });

        const output = service.build(ISSUER, FIXED_NOW)!;

        expect(output).toContain(`Expires: ${explicit}`);
      });

      it('auto-computes Expires as one year from now at midnight UTC when not set', async () => {
        const service = await createService({ contact: ['mailto:security@example.com'] });
        const output = service.build(ISSUER, FIXED_NOW)!;

        expect(output).toContain(`Expires: ${FIXED_EXPIRES}`);
      });

      it('includes the Canonical field pointing to itself', async () => {
        const service = await createService({ contact: ['mailto:security@example.com'] });
        const output = service.build(ISSUER, FIXED_NOW)!;

        expect(output).toContain(`Canonical: ${ISSUER}/.well-known/security.txt`);
      });

      it('reflects a non-default issuer in the Canonical field', async () => {
        const customIssuer = 'https://bge.myserver.io';
        const service = await createService({ contact: ['mailto:security@example.com'] });
        const output = service.build(customIssuer, FIXED_NOW)!;

        expect(output).toContain(`Canonical: ${customIssuer}/.well-known/security.txt`);
      });
    });

    describe('optional fields', () => {
      it('includes Policy when configured', async () => {
        const service = await createService({
          contact: ['mailto:security@example.com'],
          policy: 'https://example.com/security-policy',
        });

        expect(service.build(ISSUER, FIXED_NOW)).toContain('Policy: https://example.com/security-policy');
      });

      it('includes Encryption when configured', async () => {
        const service = await createService({
          contact: ['mailto:security@example.com'],
          encryption: 'https://example.com/pgp-key.asc',
        });

        expect(service.build(ISSUER, FIXED_NOW)).toContain('Encryption: https://example.com/pgp-key.asc');
      });

      it('includes Acknowledgments when configured', async () => {
        const service = await createService({
          contact: ['mailto:security@example.com'],
          acknowledgments: 'https://example.com/thanks',
        });

        expect(service.build(ISSUER, FIXED_NOW)).toContain('Acknowledgments: https://example.com/thanks');
      });

      it('includes Preferred-Languages when configured', async () => {
        const service = await createService({
          contact: ['mailto:security@example.com'],
          preferredLanguages: 'en, fr',
        });

        expect(service.build(ISSUER, FIXED_NOW)).toContain('Preferred-Languages: en, fr');
      });

      it('includes Hiring when configured', async () => {
        const service = await createService({
          contact: ['mailto:security@example.com'],
          hiring: 'https://example.com/jobs',
        });

        expect(service.build(ISSUER, FIXED_NOW)).toContain('Hiring: https://example.com/jobs');
      });
    });

    describe('optional fields — absent when not configured', () => {
      let output: string;

      beforeEach(async () => {
        const service = await createService({ contact: ['mailto:security@example.com'] });
        output = service.build(ISSUER, FIXED_NOW)!;
      });

      it('omits Policy when not configured', () => {
        expect(output).not.toContain('Policy:');
      });

      it('omits Encryption when not configured', () => {
        expect(output).not.toContain('Encryption:');
      });

      it('omits Acknowledgments when not configured', () => {
        expect(output).not.toContain('Acknowledgments:');
      });

      it('omits Hiring when not configured', () => {
        expect(output).not.toContain('Hiring:');
      });
    });

    describe('format correctness', () => {
      it('includes a comment header', async () => {
        const service = await createService({ contact: ['mailto:security@example.com'] });
        const output = service.build(ISSUER, FIXED_NOW)!;

        expect(output).toMatch(/^# /m);
      });

      it('ends with a trailing newline per RFC 9116 §3', async () => {
        const service = await createService({ contact: ['mailto:security@example.com'] });
        const output = service.build(ISSUER, FIXED_NOW)!;

        expect(output.endsWith('\n')).toBe(true);
      });

      it('produces a full document with all fields in correct order', async () => {
        const service = await createService({
          contact: ['mailto:security@example.com'],
          expires: '2027-01-01T00:00:00.000Z',
          policy: 'https://example.com/security-policy',
          encryption: 'https://example.com/pgp-key.asc',
          acknowledgments: 'https://example.com/thanks',
          preferredLanguages: 'en',
          hiring: 'https://example.com/jobs',
        });

        const output = service.build(ISSUER, FIXED_NOW)!;
        const contactIdx = output.indexOf('Contact:');
        const expiresIdx = output.indexOf('Expires:');
        const canonicalIdx = output.indexOf('Canonical:');
        const policyIdx = output.indexOf('Policy:');

        // Contact must come before Expires and Canonical
        expect(contactIdx).toBeLessThan(expiresIdx);
        expect(expiresIdx).toBeLessThan(canonicalIdx);
        expect(canonicalIdx).toBeLessThan(policyIdx);
      });

      it('auto-computed Expires is parseable as a valid ISO 8601 date', async () => {
        const service = await createService({ contact: ['mailto:security@example.com'] });
        const output = service.build(ISSUER, FIXED_NOW)!;

        const match = output.match(/^Expires: (.+)$/m);
        expect(match).not.toBeNull();
        expect(Number.isNaN(Date.parse(match![1]))).toBe(false);
      });

      it('auto-computed Expires is in the future relative to now', async () => {
        const service = await createService({ contact: ['mailto:security@example.com'] });
        const output = service.build(ISSUER, FIXED_NOW)!;

        const match = output.match(/^Expires: (.+)$/m);
        const expires = new Date(match![1]);

        expect(expires.getTime()).toBeGreaterThan(FIXED_NOW.getTime());
      });
    });

    describe('Expires auto-computation', () => {
      it('sets Expires to midnight UTC one year from the provided now', async () => {
        const service = await createService({ contact: ['mailto:security@example.com'] });

        const customNow = new Date('2024-03-10T15:30:00.000Z');
        const output = service.build(ISSUER, customNow)!;

        // Midnight UTC on 2025-03-10
        expect(output).toContain('Expires: 2025-03-10T00:00:00.000Z');
      });
    });
  });
});
