import { RiskLevel, type Permission } from '@bge/database';
import { buildPluginManifest, validatePluginManifest } from '@boardgamesempire/plugin-manifest';
import type { PluginInstallAssessment } from '../install/plugin-installer.service';
import type { StaticAnalysisReport } from '../install/static-analysis.types';
import { presentArtifactChecks } from './artifact-check-presentation';

describe('presentArtifactChecks', () => {
  const analysis: StaticAnalysisReport = {
    findings: [],
    scannedFileCount: 0,
    deepScannedFileCount: 0,
    truncated: false,
  };

  const assessmentFor = (
    corePermissions: ReadonlyMap<string, Permission>,
    reason?: Record<string, string>,
  ): PluginInstallAssessment => {
    const manifest = buildPluginManifest();
    manifest.permissions.checks = [
      ...manifest.permissions.checks,
      {
        slug: 'read:ghost_table',
        required: false,
        reason: reason ?? { en: 'Reads a table the catalog has no row for.' },
      },
    ];
    const validated = validatePluginManifest(manifest, { bgeVersion: '1.0.0', defaultLocale: 'en' });

    return {
      validated,
      serverChecks: validated.permissionChecks,
      corePermissions,
      criticalSlugsToReenter: [],
      analysis,
      forbiddenImportsToAccept: [],
    };
  };

  it('presents every requested permission with its risk and no decision (#1094)', () => {
    const presented = presentArtifactChecks(
      assessmentFor(new Map([['feedback:read', { slug: 'feedback:read', riskLevel: RiskLevel.High } as Permission]])),
      undefined,
      'en',
    );

    expect(presented.map((check) => [check.slug, check.riskLevel])).toEqual([
      ['plugin|demo-sink|manage:digest', RiskLevel.Low],
      ['feedback:read', RiskLevel.High],
      ['read:ghost_table', null],
    ]);
    expect(presented[1]).toEqual(
      expect.objectContaining({
        origin: 'core',
        required: false,
        consentScope: 'server',
        reason: expect.objectContaining({ value: 'Reads submitted feedback to compose the weekly digest.' }),
      }),
    );

    for (const check of presented) {
      expect(check).not.toHaveProperty('decision');
      expect(check).not.toHaveProperty('decidableByUnit');
      expect(check).not.toHaveProperty('decidedRiskLevel');
      expect(check).not.toHaveProperty('staleRisk');
    }
  });

  it('takes the catalog risk for a plugin-origin check that has a row, as the consent presentation does (#1094)', () => {
    const declared = 'plugin|demo-sink|manage:digest';

    const presented = presentArtifactChecks(
      assessmentFor(new Map([[declared, { slug: declared, riskLevel: RiskLevel.High } as Permission]])),
      undefined,
      'en',
    );

    expect(presented[0]).toMatchObject({ slug: declared, origin: 'plugin', riskLevel: RiskLevel.High });
  });

  it('resolves each reason in the requested locale, falling back to the default (#1094)', () => {
    const assessment = assessmentFor(new Map(), { en: 'Reads a ghost table.', de: 'Liest eine Geistertabelle.' });

    const german = presentArtifactChecks(assessment, 'de', 'en');
    const french = presentArtifactChecks(assessment, 'fr', 'en');

    expect(german[2].reason).toEqual({ value: 'Liest eine Geistertabelle.', locale: 'de', usedFallback: false });
    expect(french[2].reason).toEqual(expect.objectContaining({ value: 'Reads a ghost table.', usedFallback: true }));
  });
});
