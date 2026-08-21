import { assertPluginUnit, type PluginUnit } from '@bge/actor-context';
import { DatabaseService, RiskLevel } from '@bge/database';
import {
  resolveLocalizedStringDetailed,
  type LocalizedString,
  type PluginManifestValidationResult,
  type ResolvedLocalizedString,
} from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { revalidateStoredManifest } from '../manifest/stored-manifest';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import { unitOwnsConsentScope } from './consent-classification.types';
import {
  PluginConsentPresentationManifestError,
  PluginConsentPresentationNotFoundError,
  PluginConsentPresentationTombstonedError,
} from './consent-presentation.errors';
import type { PluginCheckPresentation, PluginConsentPresentation } from './consent-presentation.types';
import { PluginConsentCheckClassifier } from './plugin-consent-check-classifier.service';

/**
 * The `Plugin` columns both presentation paths read. Exported so callers
 * holding a wider row (a full `Plugin`) can hand it to the snapshot-taking
 * entry point without a cast.
 */
export interface PresentablePluginRow {
  readonly id: string;
  readonly slug: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly uninstalledAt: Date | null;
  readonly manifestJson: unknown;
  readonly pendingVersion: string | null;
  /**
   * Nullable column — `null` means no staged update. Typed `unknown` like
   * `manifestJson` because stored manifests are distrusted (re-validated on
   * every read), and `unknown` already admits `null`; narrowing to a JSON
   * shape would claim structure this service deliberately does not trust.
   */
  readonly pendingManifestJson: unknown;
}

const PRESENTABLE_PLUGIN_SELECT = {
  id: true,
  slug: true,
  version: true,
  enabled: true,
  uninstalledAt: true,
  manifestJson: true,
  pendingVersion: true,
  pendingManifestJson: true,
} as const;

/**
 * The install/update consent-presentation assembler: manifest
 * check × catalog risk × `PluginGrant` state × requester locale, per unit.
 * C4 renders it — the install response enriches the just-installed manifest
 * (Server unit), the update-approval screen presents the STAGED manifest
 * against today's decisions (`presentPendingForUnit`), and the unit consent
 * screens present each household/user its own decidable surface.
 *
 * Decision states come from `PluginConsentCheckClassifier` — the same
 * classification feature-state derives from, so the consent screen and the
 * feature answer cannot disagree about what `pending` or `denied` means.
 *
 * Locale is an explicit parameter: the C4 edge resolves the requester's
 * locale (CLS) and passes it down; this service never reads request state.
 * Every localized value carries its resolution provenance
 * (`ResolvedLocalizedString.usedFallback`) so the renderer can expose an
 * untranslated surface honestly.
 *
 * Returns `null` when there is nothing to present: no `Plugin` row, a
 * tombstoned plugin (its grants are purged and `decide()` refuses new
 * ones — no consent surface exists, and the tombstone check runs BEFORE
 * manifest re-validation so a stale stored manifest cannot turn
 * "uninstalled" into a 5xx), or (`presentPendingForUnit`) no staged update.
 */
@Injectable()
export class PluginConsentPresentationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly classifier: PluginConsentCheckClassifier,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /**
   * Present the ACTIVE manifest's consent surface for one (plugin, unit).
   */
  async presentForUnit(pluginId: string, unit: PluginUnit, locale?: string): Promise<PluginConsentPresentation | null> {
    const plugin = await this.loadPresentable(pluginId, unit);
    if (plugin === null) {
      return null;
    }

    const validated = this.revalidate(plugin, {
      version: plugin.version,
      manifestJson: plugin.manifestJson,
    });

    return this.assemble(plugin, validated, 'active', unit, locale);
  }

  /**
   * {@link presentForUnit} addressed by slug, for the HTTP edge (D-BO,
   * #322): plugins are slug-addressed at every endpoint (D-AX), and the
   * edge owes D-AY's 404/410 distinction — which the null-for-both
   * contract of the id-addressed form cannot feed. Throws instead of
   * returning null; the tombstone check still runs BEFORE manifest
   * re-validation so a stale stored manifest cannot turn "uninstalled"
   * into a 5xx.
   */
  async presentForUnitBySlug(slug: string, unit: PluginUnit, locale?: string): Promise<PluginConsentPresentation> {
    assertPluginUnit(unit, `Consent presentation for plugin '${slug}'`);

    const plugin = await this.db.plugin.findUnique({ where: { slug }, select: PRESENTABLE_PLUGIN_SELECT });

    if (plugin === null) {
      throw new PluginConsentPresentationNotFoundError(slug);
    }

    if (plugin.uninstalledAt !== null) {
      throw new PluginConsentPresentationTombstonedError(slug, plugin.uninstalledAt);
    }

    const validated = this.revalidate(plugin, {
      version: plugin.version,
      manifestJson: plugin.manifestJson,
    });

    return this.assemble(plugin, validated, 'active', unit, locale);
  }

  /**
   * Present a STAGED update's consent surface — the pending manifest's
   * checks classified against today's decisions, which is exactly what an
   * approval screen needs: which checks approval will seed (`pending` at
   * server scope), which are already covered, and which a durable denial
   * blocks. Checks that moved consent scope read `pending` at their NEW
   * scope: the old scope's row is not theirs anymore (activation deletes
   * it), and consent starts fresh with the principal that now owns it.
   */
  async presentPendingForUnit(
    pluginId: string,
    unit: PluginUnit,
    locale?: string,
  ): Promise<PluginConsentPresentation | null> {
    const plugin = await this.loadPresentable(pluginId, unit);

    if (plugin === null) {
      return null;
    }

    return this.presentPendingFromRow(plugin, unit, locale);
  }

  /**
   * The snapshot-taking form of {@link presentPendingForUnit}, for a
   * composer that pairs this surface with other reads of the SAME row
   * (#321's pending read). Re-reading here would open a window in which the
   * staged update resolves and is REPLACED between the two reads — and a
   * version match cannot detect that, because a rejected version can be
   * re-staged under the same number with different content. Presenting from
   * the caller's row makes the composed response consistent by
   * construction. Same null contract as the loading form: a tombstoned row,
   * or one with nothing staged, has no pending consent surface.
   */
  async presentPendingFromRow(
    plugin: PresentablePluginRow,
    unit: PluginUnit,
    locale?: string,
  ): Promise<PluginConsentPresentation | null> {
    assertPluginUnit(unit, `Consent presentation for plugin '${plugin.id}'`);

    if (plugin.uninstalledAt !== null || plugin.pendingVersion === null || plugin.pendingManifestJson === null) {
      return null;
    }

    const validated = this.revalidate(plugin, {
      version: plugin.pendingVersion,
      manifestJson: plugin.pendingManifestJson,
    });

    return this.assemble(plugin, validated, 'pending', unit, locale);
  }

  private async loadPresentable(pluginId: string, unit: PluginUnit): Promise<PresentablePluginRow | null> {
    // Same boundary posture as every other unit ingress: a structurally
    // invalid unit — C4 builds these from request input — fails loudly here
    // instead of surfacing as an opaque Prisma error mid-assembly.
    assertPluginUnit(unit, `Consent presentation for plugin '${pluginId}'`);

    const plugin = await this.db.plugin.findUnique({ where: { id: pluginId }, select: PRESENTABLE_PLUGIN_SELECT });

    if (plugin === null || plugin.uninstalledAt !== null) {
      return null;
    }

    return plugin;
  }

  private revalidate(
    plugin: PresentablePluginRow,
    source: { readonly version: string; readonly manifestJson: unknown },
  ): PluginManifestValidationResult {
    return revalidateStoredManifest(
      {
        slug: plugin.slug,
        version: source.version,
        manifestJson: source.manifestJson,
      },
      this.options,
      (pluginSlug, detail, issues) => new PluginConsentPresentationManifestError(pluginSlug, detail, issues),
    );
  }

  private async assemble(
    plugin: PresentablePluginRow,
    validated: PluginManifestValidationResult,
    source: PluginConsentPresentation['source'],
    unit: PluginUnit,
    locale: string | undefined,
  ): Promise<PluginConsentPresentation> {
    const classification = await this.classifier.classify(plugin.id, unit, validated.permissionChecks);

    const resolveText = (value: LocalizedString): ResolvedLocalizedString =>
      resolveLocalizedStringDetailed(value, {
        locale: locale ?? this.options.defaultLocale,
        defaultLocale: this.options.defaultLocale,
      });

    const checks = validated.permissionChecks.map((check): PluginCheckPresentation => {
      const classified = classification.decisions.get(check.canonicalSlug);
      const catalogRisk = classification.currentRiskBySlug.get(check.canonicalSlug);

      return {
        slug: check.canonicalSlug,
        origin: check.origin,
        required: check.required,
        consentScope: check.consentScope,
        feature: check.feature ?? null,
        decidableByUnit: unitOwnsConsentScope(check.consentScope, unit),
        decision: classified?.decision ?? 'per-unit',
        // An own-namespace check with no catalog row yet (a pending update's
        // new declare) presents the locked Low every plugin-declared row
        // carries (#59) — the row activation creates can hold nothing else.
        // A CORE check with no row stays null: its risk is unknowable, and
        // its decision reads pending.
        riskLevel: catalogRisk ?? (check.origin === 'plugin' ? RiskLevel.Low : null),
        decidedRiskLevel: classified?.decidedRiskLevel ?? null,
        staleRisk: classified?.staleRisk ?? false,
        reason: resolveText(check.reason),
      } satisfies PluginCheckPresentation;
    });

    return {
      plugin: { id: plugin.id, slug: plugin.slug, enabled: plugin.enabled },
      manifestVersion: validated.manifest.version,
      source,
      unit,
      displayName: resolveText(validated.manifest.displayName),
      description: resolveText(validated.manifest.description),
      features: validated.manifest.features.map((feature) => ({
        name: feature.name,
        displayName: resolveText(feature.displayName),
        description: resolveText(feature.description),
      })),
      checks,
    } satisfies PluginConsentPresentation;
  }
}
