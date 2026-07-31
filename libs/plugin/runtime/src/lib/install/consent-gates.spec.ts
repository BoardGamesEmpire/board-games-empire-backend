import { RiskLevel, type Permission } from '@bge/database';
import { buildPluginManifest, validatePluginManifest } from '@boardgamesempire/plugin-manifest';
import {
  collectForbiddenPermissionViolations,
  collectWildcardSubjectViolations,
  compareExactReentry,
  criticalConfirmationExpectation,
  resolveForbiddenSpecifierAcknowledgement,
} from './consent-gates';
import type { StaticAnalysisFinding } from './static-analysis.types';

/**
 * The extracted consent-gate helpers shared by install (C2) and update
 * (C3). Gate BEHAVIOR under each pipeline's errors stays in the service
 * specs; this covers the shared classification logic itself.
 */
describe('consent-gates', () => {
  const validate = (manifest: unknown) =>
    validatePluginManifest(manifest, { bgeVersion: '0.3.0', defaultLocale: 'en' });

  describe('collectForbiddenPermissionViolations', () => {
    it('accepts the clean fixture', () => {
      expect(collectForbiddenPermissionViolations(validate(buildPluginManifest()))).toEqual([]);
    });

    it('flags plugin-administration authority requested as a core check', () => {
      const validated = validate(
        buildPluginManifest({
          permissions: {
            declares: [],
            checks: [
              {
                slug: 'manage:plugin',
                required: true,
                reason: { en: 'Administers the plugin subsystem.' },
                consentScope: 'server',
              },
            ],
          },
        }),
      );

      expect(collectForbiddenPermissionViolations(validated)).toEqual([
        expect.objectContaining({
          permissionSlug: 'manage:plugin',
          detail: expect.stringContaining('self-escalation'),
        }),
      ]);
    });

    it('flags a declared bare slug that mimics the administration vocabulary', () => {
      const validated = validate(buildPluginManifest({ permissions: { declares: ['manage:plugin'], checks: [] } }));

      expect(collectForbiddenPermissionViolations(validated)).toEqual([
        expect.objectContaining({ detail: expect.stringContaining('mimics the plugin-administration vocabulary') }),
      ]);
    });

    it("flags a declared slug claiming the 'all' subject", () => {
      const validated = validate(buildPluginManifest({ permissions: { declares: ['manage:all'], checks: [] } }));

      expect(collectForbiddenPermissionViolations(validated)).toEqual([
        expect.objectContaining({ detail: expect.stringContaining("'all' subject") }),
      ]);
    });
  });

  describe('collectWildcardSubjectViolations', () => {
    it('flags a core check whose Permission row carries the wildcard subject', () => {
      const validated = validate(buildPluginManifest());
      const corePermissions = new Map<string, Permission>([
        ['feedback:read', { slug: 'feedback:read', subject: 'all', riskLevel: RiskLevel.High } as Permission],
      ]);

      expect(collectWildcardSubjectViolations(validated, corePermissions)).toEqual([
        expect.objectContaining({ permissionSlug: 'feedback:read' }),
      ]);
    });

    it('accepts subject-scoped rows', () => {
      const validated = validate(buildPluginManifest());
      const corePermissions = new Map<string, Permission>([
        ['feedback:read', { slug: 'feedback:read', subject: 'feedback', riskLevel: RiskLevel.Medium } as Permission],
      ]);

      expect(collectWildcardSubjectViolations(validated, corePermissions)).toEqual([]);
    });
  });

  describe('criticalConfirmationExpectation', () => {
    it('returns only Critical CORE checks, sorted — plugin-declared slugs never qualify (D-W)', () => {
      const validated = validate(buildPluginManifest());
      const corePermissions = new Map<string, Permission>([
        ['feedback:read', { slug: 'feedback:read', subject: 'feedback', riskLevel: RiskLevel.Critical } as Permission],
      ]);

      expect(criticalConfirmationExpectation(validated.permissionChecks, corePermissions)).toEqual(['feedback:read']);
    });
  });

  describe('compareExactReentry', () => {
    it.each([
      { expected: ['a', 'b'], received: ['b', 'a'], exact: true },
      { expected: [], received: [], exact: true },
      { expected: ['a', 'b'], received: ['a'], exact: false },
      { expected: ['a'], received: ['a', 'b'], exact: false },
      { expected: [], received: ['a'], exact: false },
    ])('$expected vs $received → exact=$exact', ({ expected, received, exact }) => {
      expect(compareExactReentry(expected, received).exact).toBe(exact);
    });
  });

  describe('resolveForbiddenSpecifierAcknowledgement', () => {
    const finding = (specifier: string | null): StaticAnalysisFinding => ({
      kind: specifier === null ? 'non-literal-import' : 'esm-import',
      specifier,
      file: 'dist/index.js',
      severity: 'forbidden',
      scanScope: 'default',
    });

    it('deduplicates per SPECIFIER — nine files importing one module is one decision', () => {
      const resolution = resolveForbiddenSpecifierAcknowledgement(
        [finding('child_process'), finding('child_process'), finding('net')],
        ['child_process'],
      );

      expect(resolution.reported).toEqual(['child_process', 'net']);
      expect(resolution.unacknowledged).toEqual(['net']);
      expect(resolution.unexpected).toEqual([]);
    });

    it('reports acknowledged specifiers analysis never found', () => {
      const resolution = resolveForbiddenSpecifierAcknowledgement([finding('net')], ['net', 'dns']);

      expect(resolution.unexpected).toEqual(['dns']);
    });

    it('ignores specifier-less findings', () => {
      const resolution = resolveForbiddenSpecifierAcknowledgement([finding(null)], []);

      expect(resolution.reported).toEqual([]);
      expect(resolution.unacknowledged).toEqual([]);
    });
  });
});
