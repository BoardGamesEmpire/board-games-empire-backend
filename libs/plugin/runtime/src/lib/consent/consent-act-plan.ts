import type { PluginUnit } from '@bge/actor-context';
import { PluginGrantStatus, type RiskLevel } from '@bge/database';
import { resolveLocalizedStringDetailed, type NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import type { ConsentCheckClassification, ConsentManifestSource } from './consent-classification.types';
import { unitOwnsConsentScope } from './consent-classification.types';
import { byPermissionSlugCodeUnit } from './decision-lock-order';
import {
  PluginConsentActAnswerError,
  PluginConsentActRequiredSetError,
  PluginConsentActStaleError,
  PluginConsentActUngrantableError,
  type ConsentActAnswerRule,
  type ConsentActStaleRisk,
  type ConsentActUngrantablePermission,
} from './plugin-consent-act.errors';
import type {
  ConsentActAnswer,
  ConsentActDecision,
  ConsentActKind,
  ConsentActPlan,
  ConsentActPresentationCheck,
} from './plugin-consent-act.types';
import { presentedRiskLevel } from './presented-risk-level';

export interface PlanConsentActInput {
  /** The ACTIVE manifest's permissionChecks; consulted only when source is 'staged'. */
  readonly activeChecks: readonly NormalizedPermissionRequest[];
  readonly answers: readonly ConsentActAnswer[];
  /** permissionChecks of the manifest the sha names. */
  readonly checks: readonly NormalizedPermissionRequest[];
  /** classify() of `checks` for this unit, read inside the act's transaction. */
  readonly classification: ConsentCheckClassification;
  readonly defaultLocale: string;
  readonly kind: ConsentActKind;
  readonly locale: string;
  readonly pluginSlug: string;
  readonly source: ConsentManifestSource;
  readonly unit: PluginUnit;
}

/**
 * Validate one consent act's answers against the manifest it names and return
 * the consent decisions to write plus the act's record of what was shown
 * (#1150). Pure: it reads nothing and writes nothing, and it either returns a
 * plan or throws, so a refused act leaves no trace.
 *
 * Rules run in a fixed order, and the first rule broken throws for every
 * permission that breaks it: shape; then, for a switch-on, every required
 * permission that cannot be granted, answered or not; then the rules of the
 * act's kind; then grantability of the remaining answers; then risk.
 */
export function planConsentAct(input: PlanConsentActInput): ConsentActPlan {
  const { kind, pluginSlug, unit, source, checks, classification, answers } = input;

  const own = checks.filter((check) => unitOwnsConsentScope(check.consentScope, unit));
  const ownBySlug = new Map(own.map((check) => [check.canonicalSlug, check]));
  const answerBySlug = new Map(answers.map((answer) => [answer.permissionSlug, answer]));

  const refuse = (rule: ConsentActAnswerRule, slugs: readonly string[]): never => {
    // A permission named twice is listed once, in the order it was first named.
    throw new PluginConsentActAnswerError(pluginSlug, rule, [...new Set(slugs)]);
  };

  const slugsWhere = (predicate: (answer: ConsentActAnswer) => boolean): string[] =>
    answers.filter(predicate).map((answer) => answer.permissionSlug);

  // 1. Shape.
  if (source === 'staged' && kind !== 'Review') {
    refuse(
      'staged-kind',
      slugsWhere(() => true),
    );
  }

  if ((kind === 'Toggle' && answers.length !== 1) || (kind === 'Review' && answers.length === 0)) {
    refuse(
      'answer-count',
      slugsWhere(() => true),
    );
  }

  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const { permissionSlug } of answers) {
    if (seen.has(permissionSlug)) {
      duplicated.add(permissionSlug);
    }

    seen.add(permissionSlug);
  }

  if (duplicated.size > 0) {
    refuse('duplicate', [...duplicated]);
  }

  const notRequested = slugsWhere((answer) => !ownBySlug.has(answer.permissionSlug));
  if (notRequested.length > 0) {
    refuse('not-requested', notRequested);
  }

  const isRequired = (slug: string): boolean => ownBySlug.get(slug)?.required === true;
  const isDenied = (answer: ConsentActAnswer): boolean => answer.status === PluginGrantStatus.Denied;

  // The permission's risk as the consent surface shows it; null when it
  // cannot be shown at all.
  const currentRisk = (slug: string): RiskLevel | null =>
    presentedRiskLevel(ownBySlug.get(slug)?.origin ?? 'core', classification.currentRiskBySlug.get(slug));

  const ungrantableCause = (slug: string): ConsentActUngrantablePermission | null => {
    const cause = classification.decisions.get(slug)?.ungrantable ?? null;
    if (cause !== null) {
      return { permissionSlug: slug, cause };
    }

    // The classifier never leaves a permission whose risk cannot be shown
    // without a cause; this keeps the rule total if it ever does.
    return currentRisk(slug) === null ? { permissionSlug: slug, cause: 'no_catalog_row' } : null;
  };

  // 2. A switch-on's required permissions that cannot be granted, answered
  // or not. The consent surface marks them so a client leaves them out, and
  // asking for the required set would ask for something only a server admin
  // can cure, so this refusal comes first (#1150).
  if (kind === 'SwitchOn') {
    const ungrantableRequired = own
      .filter((check) => check.required)
      .map((check) => ungrantableCause(check.canonicalSlug))
      .filter((permission) => permission !== null);

    if (ungrantableRequired.length > 0) {
      throw new PluginConsentActUngrantableError(pluginSlug, ungrantableRequired);
    }
  }

  // 3. Per kind.
  switch (kind) {
    case 'SwitchOn': {
      const required = own.filter((check) => check.required);
      const missing = required.filter((check) => !answerBySlug.has(check.canonicalSlug));
      const refused = required.filter((check) => {
        const answer = answerBySlug.get(check.canonicalSlug);
        return answer !== undefined && isDenied(answer);
      });

      if (missing.length > 0 || refused.length > 0) {
        throw new PluginConsentActRequiredSetError(
          pluginSlug,
          missing.map((check) => check.canonicalSlug),
          refused.map((check) => check.canonicalSlug),
        );
      }

      break;
    }

    case 'Toggle': {
      const required = slugsWhere((answer) => isRequired(answer.permissionSlug));
      if (required.length > 0) {
        refuse('toggle-required', required);
      }

      break;
    }

    case 'Review': {
      // The server admin's approval is the Server unit's consent, so its review
      // only accepts; refusing is a toggle of an optional permission (#1336).
      if (unit.scopeType === 'Server') {
        const refusals = slugsWhere(isDenied);

        if (refusals.length > 0) {
          refuse('server-refusal', refusals);
        }
      }

      if (source === 'staged') {
        const refusals = slugsWhere(isDenied);
        if (refusals.length > 0) {
          refuse('staged-refusal', refusals);
        }

        const activeOwn = new Set(
          input.activeChecks
            .filter((check) => unitOwnsConsentScope(check.consentScope, unit))
            .map((check) => check.canonicalSlug),
        );
        const notNew = slugsWhere((answer) => activeOwn.has(answer.permissionSlug));
        if (notNew.length > 0) {
          refuse('staged-not-new', notNew);
        }
      } else {
        const refusedWhileGranted = slugsWhere(
          (answer) => isDenied(answer) && classification.decisions.get(answer.permissionSlug)?.decision === 'granted',
        );
        if (refusedWhileGranted.length > 0) {
          refuse('not-outstanding', refusedWhileGranted);
        }
      }

      break;
    }
  }

  // 4. Grantability of the remaining answers: the cause is reported whatever
  // the answer when the permission's risk cannot be shown at all, because
  // reading the consent surface again would not cure that.
  const ungrantable: ConsentActUngrantablePermission[] = [];
  for (const answer of answers) {
    const slug = answer.permissionSlug;
    if (answer.status !== PluginGrantStatus.Granted && currentRisk(slug) !== null) {
      continue;
    }

    const permission = ungrantableCause(slug);
    if (permission !== null) {
      ungrantable.push(permission);
    }
  }

  if (ungrantable.length > 0) {
    throw new PluginConsentActUngrantableError(pluginSlug, ungrantable);
  }

  // 5. Risk: a risk shown that is not today's, in either direction, is stale.
  const staleRisks: ConsentActStaleRisk[] = [];
  for (const answer of answers) {
    const current = currentRisk(answer.permissionSlug);
    if (current !== null && current !== answer.riskLevel) {
      staleRisks.push({
        permissionSlug: answer.permissionSlug,
        shownRiskLevel: answer.riskLevel,
        currentRiskLevel: current,
      });
    }
  }

  if (staleRisks.length > 0) {
    throw new PluginConsentActStaleError(pluginSlug, 'risk', staleRisks);
  }

  // 6. The plan.
  const decisions: ConsentActDecision[] = answers
    .map((answer) => ({
      permissionSlug: answer.permissionSlug,
      status: answer.status,
      decidedRiskLevel: answer.riskLevel,
    }))
    .sort(byPermissionSlugCodeUnit);

  const presentationChecks = own.map((check): ConsentActPresentationCheck => {
    const resolved = resolveLocalizedStringDetailed(check.reason, {
      locale: input.locale,
      defaultLocale: input.defaultLocale,
    });
    const answered = answerBySlug.get(check.canonicalSlug);

    return {
      slug: check.canonicalSlug,
      required: check.required,
      feature: check.feature ?? null,
      riskLevel: currentRisk(check.canonicalSlug),
      reason: resolved.value,
      usedFallback: resolved.usedFallback,
      outcome: answered === undefined ? 'unanswered' : isDenied(answered) ? 'refused' : 'granted',
    };
  });

  return {
    decisions,
    switchesOff:
      kind === 'Review' &&
      source === 'active' &&
      answers.some((answer) => isDenied(answer) && isRequired(answer.permissionSlug)),
    presentation: { locale: input.locale, source, checks: presentationChecks },
  };
}
