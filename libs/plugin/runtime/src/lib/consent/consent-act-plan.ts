import { PluginGrantStatus, type RiskLevel } from '@bge/database';
import { resolveLocalizedStringDetailed, type NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import type { ConsentCheckClassification } from './consent-classification.types';
import { unitOwnsConsentScope } from './consent-classification.types';
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
  ConsentActSource,
  ConsentActUnit,
} from './plugin-consent-act.types';
import { presentedRiskLevel } from './presented-risk-level';

export interface PlanConsentActInput {
  readonly kind: ConsentActKind;
  readonly pluginSlug: string;
  readonly unit: ConsentActUnit;
  readonly source: ConsentActSource;
  /** permissionChecks of the manifest the sha names. */
  readonly checks: readonly NormalizedPermissionRequest[];
  /** The ACTIVE manifest's permissionChecks; consulted only when source is 'pending'. */
  readonly activeChecks: readonly NormalizedPermissionRequest[];
  /** classify() of `checks` for this unit, read inside the act's transaction. */
  readonly classification: ConsentCheckClassification;
  readonly answers: readonly ConsentActAnswer[];
  readonly locale: string;
  readonly defaultLocale: string;
}

/**
 * Validate one consent act's answers against the manifest it names and return
 * the consent decisions to write plus the act's record of what was shown
 * (#1150). Pure: it reads nothing and writes nothing, and it either returns a
 * plan or throws, so a refused act leaves no trace.
 *
 * Rules run in a fixed order, and the first rule broken throws for every
 * permission that breaks it: shape, then the rules of the act's kind, then
 * grantability, then risk.
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
  if (source === 'pending' && kind !== 'Review') {
    refuse(
      'staged-kind',
      slugsWhere(() => true),
    );
  }

  if ((kind === 'Toggle' && answers.length !== 1) || (kind === 'Review' && answers.length === 0)) {
    refuse(
      'empty',
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

  // 2. Per kind.
  const isRequired = (slug: string): boolean => ownBySlug.get(slug)?.required === true;
  const isDenied = (answer: ConsentActAnswer): boolean => answer.status === PluginGrantStatus.Denied;

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
      if (source === 'pending') {
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
        const outstandingNone = slugsWhere(
          (answer) => isDenied(answer) && classification.decisions.get(answer.permissionSlug)?.decision === 'granted',
        );
        if (outstandingNone.length > 0) {
          refuse('not-outstanding', outstandingNone);
        }
      }
      break;
    }
  }

  // 3. Grantability: the cause is reported whatever the answer when the
  // permission's risk cannot be shown at all, because reading the consent
  // surface again would not cure that.
  const currentRisk = (slug: string): RiskLevel | null =>
    presentedRiskLevel(ownBySlug.get(slug)?.origin ?? 'core', classification.currentRiskBySlug.get(slug));

  const ungrantable: ConsentActUngrantablePermission[] = [];
  for (const answer of answers) {
    const slug = answer.permissionSlug;
    const mustBeGrantable =
      answer.status === PluginGrantStatus.Granted ||
      (kind === 'SwitchOn' && isRequired(slug)) ||
      currentRisk(slug) === null;
    if (!mustBeGrantable) {
      continue;
    }

    const cause = classification.decisions.get(slug)?.ungrantable ?? null;
    if (cause !== null) {
      ungrantable.push({ permissionSlug: slug, cause });
    } else if (currentRisk(slug) === null) {
      ungrantable.push({ permissionSlug: slug, cause: 'no_catalog_row' });
    }
  }
  if (ungrantable.length > 0) {
    throw new PluginConsentActUngrantableError(pluginSlug, ungrantable);
  }

  // 4. Risk: a risk shown that is not today's, in either direction, is stale.
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

  // 5. The plan.
  const decisions: ConsentActDecision[] = answers
    .map((answer) => ({
      permissionSlug: answer.permissionSlug,
      status: answer.status,
      decidedRiskLevel: answer.riskLevel,
    }))
    // Code-unit order, not locale order: this is a lock order every process must agree on.
    .sort((a, b) => (a.permissionSlug < b.permissionSlug ? -1 : a.permissionSlug > b.permissionSlug ? 1 : 0));

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
