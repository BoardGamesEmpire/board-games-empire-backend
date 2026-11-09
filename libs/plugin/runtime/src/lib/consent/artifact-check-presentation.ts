import { resolveLocalizedStringDetailed } from '@boardgamesempire/plugin-manifest';
import type { PluginInstallAssessment } from '../install/plugin-installer.service';
import type { PluginCheckPresentation } from './consent-presentation.types';
import { presentedRiskLevel } from './presented-risk-level';

/**
 * One requested permission as the artifact step shows it. An artifact is not
 * installed yet, so no unit has decided anything: the decision fields of
 * `PluginCheckPresentation` do not apply (#1094).
 */
export type PluginArtifactCheckPresentation = Omit<
  PluginCheckPresentation,
  'decidableByUnit' | 'decision' | 'decidedRiskLevel' | 'staleRisk'
>;

/**
 * Every permission the artifact's manifest requests, in manifest order, with
 * its risk and the author's reason in the requested locale. Risk follows the
 * consent presentation's rule (`presentedRiskLevel`): the catalog row's risk
 * where there is one, otherwise `Low` for a declared permission and `null`
 * for a core one (#59).
 */
export const presentArtifactChecks = (
  assessment: PluginInstallAssessment,
  locale: string | undefined,
  defaultLocale: string,
): readonly PluginArtifactCheckPresentation[] =>
  assessment.validated.permissionChecks.map(
    (check): PluginArtifactCheckPresentation => ({
      slug: check.canonicalSlug,
      origin: check.origin,
      required: check.required,
      consentScope: check.consentScope,
      feature: check.feature ?? null,
      riskLevel: presentedRiskLevel(check.origin, assessment.corePermissions.get(check.canonicalSlug)?.riskLevel),
      reason: resolveLocalizedStringDetailed(check.reason, { locale: locale ?? defaultLocale, defaultLocale }),
    }),
  );
