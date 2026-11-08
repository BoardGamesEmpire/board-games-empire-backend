import type { PluginUnit } from '@bge/actor-context';
import { RiskLevel } from '@bge/database';
import { resolveLocalizedString, type NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import {
  unitConsumesConsentScope,
  unitOwnsConsentScope,
  type ClassifiedConsentCheck,
} from './consent-classification.types';
import { PluginConsentCheckClassifier } from './plugin-consent-check-classifier.service';
import type {
  ConsentOutstandingCheck,
  ConsentOutstandingKind,
  PluginConsentStanding,
  PluginConsentStandingDetail,
} from './plugin-consent-standing.types';

/**
 * The one read-time answer to "what does this consent unit still owe the
 * plugin" (#1149). A stored suspension flag needs every writer to keep it in
 * sync, and each gap leaves a unit wrongly suspended or wrongly served
 * (#1061, #1063, #1147). The standing is instead worked out on every read
 * from the unit's grants, the active manifest and today's catalog risk, so a
 * manifest replacement or a catalog risk change shows up on the next read
 * with no writer involved.
 *
 * Per-check decisions come from `PluginConsentCheckClassifier`, the same
 * classification feature state and the consent surface read, so the three
 * cannot disagree about which checks confer.
 *
 * No caching: a consent decision must be visible on the next read.
 */
@Injectable()
export class PluginConsentStandingService {
  constructor(
    private readonly classifier: PluginConsentCheckClassifier,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /**
   * `checks` is the active manifest's `permissionChecks`; only the ones the
   * unit's resolution consumes (server-consented checks plus the unit's own
   * scope) are classified. A check decided on another unit axis never enters
   * this unit's resolution, so it owes nothing here.
   *
   * Required permissions that do not confer land in `outstanding`, optional
   * permissions in `optionalOff`; both keep manifest order. A conferring
   * check appears in neither.
   */
  async resolve(
    pluginId: string,
    unit: PluginUnit,
    checks: readonly NormalizedPermissionRequest[],
    locale?: string,
  ): Promise<PluginConsentStanding> {
    return (await this.resolveDetailed(pluginId, unit, checks, locale)).standing;
  }

  /**
   * {@link resolve} plus what the wire shape leaves out: which listed checks
   * a durable denial blocks, whichever scope recorded it. Feature state reads
   * it to say `denied` rather than `pending` for a feature a server admin's
   * refusal dead-ends, while the check's kind still tells the household or
   * user that the cure lies elsewhere (#1149).
   */
  async resolveDetailed(
    pluginId: string,
    unit: PluginUnit,
    checks: readonly NormalizedPermissionRequest[],
    locale?: string,
  ): Promise<PluginConsentStandingDetail> {
    const consumed = checks.filter((check) => unitConsumesConsentScope(check.consentScope, unit));
    const { decisions, currentRiskBySlug } = await this.classifier.classify(pluginId, unit, consumed);

    const outstanding: ConsentOutstandingCheck[] = [];
    const optionalOff: ConsentOutstandingCheck[] = [];
    const refusedSlugs = new Set<string>();

    for (const check of consumed) {
      const classified = decisions.get(check.canonicalSlug);

      if (classified?.decision === 'granted') {
        continue;
      }

      if (classified?.decision === 'denied') {
        refusedSlugs.add(check.canonicalSlug);
      }

      const entry: ConsentOutstandingCheck = {
        slug: check.canonicalSlug,
        kind: this.kindOf(check, unit, classified),
        required: check.required,
        feature: check.feature ?? null,
        // A declared permission is Low by definition (#59), with or without
        // its catalog row, which is also what the consent surface shows; only
        // a core permission's risk is unknowable once its row is gone.
        riskLevel: currentRiskBySlug.get(check.canonicalSlug) ?? (check.origin === 'plugin' ? RiskLevel.Low : null),
        reason: resolveLocalizedString(check.reason, {
          locale: locale ?? this.options.defaultLocale,
          defaultLocale: this.options.defaultLocale,
        }),
      };

      (check.required ? outstanding : optionalOff).push(entry);
    }

    return { standing: { outstanding, optionalOff }, refusedSlugs };
  }

  /**
   * Ownership is asked first: a server-consented check seen from a household
   * or user is a server admin's to answer whatever its row says, so the unit is
   * told the cure lies elsewhere rather than offered a decision it cannot
   * make (#1147). A missing classification reads as `never_asked`, the same
   * as the classifier's own "no row" pending.
   */
  private kindOf(
    check: NormalizedPermissionRequest,
    unit: PluginUnit,
    classified: ClassifiedConsentCheck | undefined,
  ): ConsentOutstandingKind {
    if (!unitOwnsConsentScope(check.consentScope, unit)) {
      return 'outstanding_elsewhere';
    }

    if (classified?.decision === 'denied') {
      return 'refused';
    }

    if (classified?.staleRisk === true) {
      return 'risk_raised';
    }

    return 'never_asked';
  }
}
