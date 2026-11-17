import { SERVER_PLUGIN_UNIT, type HouseholdPluginUnit } from '@bge/actor-context';
import { PluginGrantStatus, RiskLevel } from '@bge/database';
import type { NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import type { ConsentUngrantableCause } from '../grants/consent-grantability';
import { planConsentAct } from './consent-act-plan';
import type { ClassifiedConsentCheck, ConsentCheckClassification } from './consent-classification.types';
import {
  PluginConsentActAnswerError,
  PluginConsentActRequiredSetError,
  PluginConsentActStaleError,
  PluginConsentActUngrantableError,
} from './plugin-consent-act.errors';
import type { ConsentActAnswer } from './plugin-consent-act.types';

const UNIT: HouseholdPluginUnit = { scopeType: 'Household', householdId: 'hh-1' };

const REQUIRED_CORE = 'read:game:public';
const REQUIRED_DECLARED = 'plug:manage:digest';
const OPTIONAL_CORE = 'read:game_collection:public';
const SERVER_CHECK = 'read:household:public';
const STAGED_ONLY = 'read:play:public';

const check = (
  canonicalSlug: string,
  overrides: Partial<NormalizedPermissionRequest> = {},
): NormalizedPermissionRequest => ({
  slug: canonicalSlug,
  required: false,
  reason: { en: `Needed for ${canonicalSlug}.` },
  consentScope: 'household',
  origin: 'core',
  canonicalSlug,
  ...overrides,
});

const HOUSEHOLD_CHECKS: readonly NormalizedPermissionRequest[] = [
  check(REQUIRED_CORE, { required: true, feature: 'browse' }),
  check(REQUIRED_DECLARED, { required: true, origin: 'plugin', slug: 'manage:digest' }),
  check(OPTIONAL_CORE),
  check(SERVER_CHECK, { consentScope: 'server' }),
];

const classified = (overrides: Partial<ClassifiedConsentCheck> = {}): ClassifiedConsentCheck => ({
  decision: 'pending',
  decidedRiskLevel: null,
  staleRisk: false,
  ungrantable: null,
  ...overrides,
});

const classification = (
  input: {
    readonly decisions?: Record<string, Partial<ClassifiedConsentCheck>>;
    readonly risks?: Record<string, RiskLevel>;
    readonly slugs?: readonly string[];
  } = {},
): ConsentCheckClassification => {
  const slugs = input.slugs ?? [REQUIRED_CORE, REQUIRED_DECLARED, OPTIONAL_CORE, SERVER_CHECK];
  return {
    decisions: new Map(slugs.map((slug) => [slug, classified(input.decisions?.[slug])])),
    currentRiskBySlug: new Map(
      slugs.map((slug) => [slug, RiskLevel.Low] as const).map(([slug, low]) => [slug, input.risks?.[slug] ?? low]),
    ),
  };
};

const answer = (
  permissionSlug: string,
  status: PluginGrantStatus,
  riskLevel: RiskLevel = RiskLevel.Low,
): ConsentActAnswer => ({ permissionSlug, status, riskLevel });

const granted = (slug: string, risk?: RiskLevel) => answer(slug, PluginGrantStatus.Granted, risk);
const denied = (slug: string, risk?: RiskLevel) => answer(slug, PluginGrantStatus.Denied, risk);

type PlanInput = Parameters<typeof planConsentAct>[0];

const plan = (overrides: Partial<PlanInput> & Pick<PlanInput, 'kind' | 'answers'>) =>
  planConsentAct({
    pluginSlug: 'plug',
    unit: UNIT,
    source: 'active',
    checks: HOUSEHOLD_CHECKS,
    activeChecks: HOUSEHOLD_CHECKS,
    classification: classification(),
    locale: 'en',
    defaultLocale: 'en',
    ...overrides,
  });

const thrown = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the plan to throw');
};

const expectAnswerError = (run: () => unknown, rule: string, permissionSlugs: readonly string[]) => {
  const error = thrown(run);
  expect(error).toBeInstanceOf(PluginConsentActAnswerError);
  expect(error).toMatchObject({ name: 'PluginConsentActAnswerError', pluginSlug: 'plug', rule, permissionSlugs });
};

describe('planConsentAct (#1150)', () => {
  describe('switch-on', () => {
    it('a switch-on granting the required set and one optional permission plans three decisions in slug order (#1150)', () => {
      const result = plan({
        kind: 'SwitchOn',
        answers: [granted(OPTIONAL_CORE), granted(REQUIRED_DECLARED), granted(REQUIRED_CORE)],
      });

      expect(result.switchesOff).toBe(false);
      expect(result.decisions).toEqual([
        { permissionSlug: REQUIRED_DECLARED, status: PluginGrantStatus.Granted, decidedRiskLevel: RiskLevel.Low },
        { permissionSlug: REQUIRED_CORE, status: PluginGrantStatus.Granted, decidedRiskLevel: RiskLevel.Low },
        { permissionSlug: OPTIONAL_CORE, status: PluginGrantStatus.Granted, decidedRiskLevel: RiskLevel.Low },
      ]);
    });

    it('a switch-on that leaves out a required permission names it as missing (#1150)', () => {
      const error = thrown(() => plan({ kind: 'SwitchOn', answers: [granted(REQUIRED_CORE)] }));

      expect(error).toBeInstanceOf(PluginConsentActRequiredSetError);
      expect(error).toMatchObject({ pluginSlug: 'plug', missingSlugs: [REQUIRED_DECLARED], refusedSlugs: [] });
    });

    it('a switch-on that refuses a required permission names it as refused (#1150)', () => {
      const error = thrown(() =>
        plan({ kind: 'SwitchOn', answers: [granted(REQUIRED_CORE), denied(REQUIRED_DECLARED)] }),
      );

      expect(error).toBeInstanceOf(PluginConsentActRequiredSetError);
      expect(error).toMatchObject({ pluginSlug: 'plug', missingSlugs: [], refusedSlugs: [REQUIRED_DECLARED] });
    });

    it('a switch-on with nothing required and no answers is valid and plans no decisions (#1150)', () => {
      const optionalOnly = [check(OPTIONAL_CORE)];

      const result = plan({
        kind: 'SwitchOn',
        answers: [],
        checks: optionalOnly,
        activeChecks: optionalOnly,
        classification: classification({ slugs: [OPTIONAL_CORE] }),
      });

      expect(result.decisions).toEqual([]);
      expect(result.switchesOff).toBe(false);
    });

    it('a switch-on or toggle naming the staged manifest is refused (#1150)', () => {
      expectAnswerError(
        () => plan({ kind: 'SwitchOn', source: 'staged', answers: [granted(REQUIRED_CORE)] }),
        'staged-kind',
        [REQUIRED_CORE],
      );
      expectAnswerError(
        () => plan({ kind: 'Toggle', source: 'staged', answers: [granted(OPTIONAL_CORE)] }),
        'staged-kind',
        [OPTIONAL_CORE],
      );
    });
  });

  describe('toggle', () => {
    it('a toggle on a required permission is refused (#1150)', () => {
      expectAnswerError(() => plan({ kind: 'Toggle', answers: [denied(REQUIRED_CORE)] }), 'toggle-required', [
        REQUIRED_CORE,
      ]);
    });

    it('a toggle with two answers is refused (#1150)', () => {
      expectAnswerError(
        () => plan({ kind: 'Toggle', answers: [granted(OPTIONAL_CORE), denied(OPTIONAL_CORE)] }),
        'answer-count',
        [OPTIONAL_CORE],
      );
    });

    it('a toggle on an optional permission plans one decision of either status (#1150)', () => {
      const result = plan({ kind: 'Toggle', answers: [denied(OPTIONAL_CORE)] });

      expect(result.decisions).toEqual([
        { permissionSlug: OPTIONAL_CORE, status: PluginGrantStatus.Denied, decidedRiskLevel: RiskLevel.Low },
      ]);
    });
  });

  describe('review', () => {
    it('a review that refuses a required permission switches the unit off (#1150)', () => {
      const result = plan({ kind: 'Review', answers: [denied(REQUIRED_CORE)] });

      expect(result.switchesOff).toBe(true);
      expect(result.decisions).toEqual([
        { permissionSlug: REQUIRED_CORE, status: PluginGrantStatus.Denied, decidedRiskLevel: RiskLevel.Low },
      ]);
    });

    it('a review that refuses a permission that already confers is refused (#1150)', () => {
      expectAnswerError(
        () =>
          plan({
            kind: 'Review',
            answers: [denied(OPTIONAL_CORE)],
            classification: classification({ decisions: { [OPTIONAL_CORE]: { decision: 'granted' } } }),
          }),
        'not-outstanding',
        [OPTIONAL_CORE],
      );
    });

    it('a review that grants one again is accepted, so a retry is safe (#1150)', () => {
      const result = plan({
        kind: 'Review',
        answers: [granted(OPTIONAL_CORE)],
        classification: classification({ decisions: { [OPTIONAL_CORE]: { decision: 'granted' } } }),
      });

      expect(result.decisions).toEqual([
        { permissionSlug: OPTIONAL_CORE, status: PluginGrantStatus.Granted, decidedRiskLevel: RiskLevel.Low },
      ]);
      expect(result.switchesOff).toBe(false);
    });

    it('a review with no answers is refused by the answer count (#1150)', () => {
      expectAnswerError(() => plan({ kind: 'Review', answers: [] }), 'answer-count', []);
    });
  });

  describe('staged review', () => {
    const stagedChecks = [...HOUSEHOLD_CHECKS, check(STAGED_ONLY)];
    const stagedClassification = classification({
      slugs: [REQUIRED_CORE, REQUIRED_DECLARED, OPTIONAL_CORE, SERVER_CHECK, STAGED_ONLY],
    });
    const staged = (answers: readonly ConsentActAnswer[]) =>
      plan({
        kind: 'Review',
        source: 'staged',
        checks: stagedChecks,
        activeChecks: HOUSEHOLD_CHECKS,
        classification: stagedClassification,
        answers,
      });

    it('a staged review may grant a permission only the staged manifest requests (#1150)', () => {
      const result = staged([granted(STAGED_ONLY)]);

      expect(result.decisions).toEqual([
        { permissionSlug: STAGED_ONLY, status: PluginGrantStatus.Granted, decidedRiskLevel: RiskLevel.Low },
      ]);
      expect(result.presentation.source).toBe('staged');
    });

    it('a staged review refuses a Denied answer (#1150)', () => {
      expectAnswerError(() => staged([denied(STAGED_ONLY)]), 'staged-refusal', [STAGED_ONLY]);
    });

    it('a staged review refuses a permission the active manifest already requests at this scope (#1150)', () => {
      expectAnswerError(() => staged([granted(STAGED_ONLY), granted(OPTIONAL_CORE)]), 'staged-not-new', [
        OPTIONAL_CORE,
      ]);
    });
  });

  describe('shape', () => {
    it('a permission named twice is refused, whatever the two answers say (#1150)', () => {
      expectAnswerError(
        () =>
          plan({
            kind: 'Review',
            answers: [granted(OPTIONAL_CORE), denied(OPTIONAL_CORE), granted(REQUIRED_CORE), granted(REQUIRED_CORE)],
          }),
        'duplicate',
        [OPTIONAL_CORE, REQUIRED_CORE],
      );
    });

    it('a permission another unit decides is refused as not requested here (#1150)', () => {
      expectAnswerError(() => plan({ kind: 'Review', answers: [granted(SERVER_CHECK)] }), 'not-requested', [
        SERVER_CHECK,
      ]);
    });

    it('a permission the manifest never requested is refused as not requested here (#1150)', () => {
      expectAnswerError(() => plan({ kind: 'Review', answers: [granted('read:play:public')] }), 'not-requested', [
        'read:play:public',
      ]);
    });
  });

  describe('risk and grantability', () => {
    it('a named risk that differs from the current risk is refused as stale, in either direction (#1150)', () => {
      const lowShownHighNow = thrown(() =>
        plan({
          kind: 'Toggle',
          answers: [granted(OPTIONAL_CORE, RiskLevel.Low)],
          classification: classification({ risks: { [OPTIONAL_CORE]: RiskLevel.High } }),
        }),
      );
      expect(lowShownHighNow).toBeInstanceOf(PluginConsentActStaleError);
      expect(lowShownHighNow).toMatchObject({
        name: 'PluginConsentActStaleError',
        pluginSlug: 'plug',
        kind: 'risk',
        staleRisks: [
          { permissionSlug: OPTIONAL_CORE, shownRiskLevel: RiskLevel.Low, currentRiskLevel: RiskLevel.High },
        ],
      });

      const highShownLowNow = thrown(() => plan({ kind: 'Toggle', answers: [denied(OPTIONAL_CORE, RiskLevel.High)] }));
      expect(highShownLowNow).toBeInstanceOf(PluginConsentActStaleError);
      expect(highShownLowNow).toMatchObject({
        kind: 'risk',
        staleRisks: [
          { permissionSlug: OPTIONAL_CORE, shownRiskLevel: RiskLevel.High, currentRiskLevel: RiskLevel.Low },
        ],
      });
    });

    it('a required permission that cannot be granted refuses the switch-on and names it (#1150)', () => {
      const cause: ConsentUngrantableCause = 'wildcard_subject';
      const error = thrown(() =>
        plan({
          kind: 'SwitchOn',
          answers: [granted(REQUIRED_CORE), granted(REQUIRED_DECLARED)],
          classification: classification({ decisions: { [REQUIRED_CORE]: { ungrantable: cause } } }),
        }),
      );

      expect(error).toBeInstanceOf(PluginConsentActUngrantableError);
      expect(error).toMatchObject({
        name: 'PluginConsentActUngrantableError',
        pluginSlug: 'plug',
        permissions: [{ permissionSlug: REQUIRED_CORE, cause }],
      });
    });

    it('a switch-on that leaves out a required permission that cannot be granted is refused as ungrantable, naming it (#1150)', () => {
      // The consent surface marks it not grantable, so a client leaves it out;
      // the required-set refusal would ask for something it cannot do.
      const error = thrown(() =>
        plan({
          kind: 'SwitchOn',
          answers: [granted(REQUIRED_DECLARED)],
          classification: classification({ decisions: { [REQUIRED_CORE]: { ungrantable: 'wildcard_subject' } } }),
        }),
      );

      expect(error).toBeInstanceOf(PluginConsentActUngrantableError);
      expect(error).toMatchObject({ permissions: [{ permissionSlug: REQUIRED_CORE, cause: 'wildcard_subject' }] });
    });

    it('a switch-on that leaves out a required core permission with no catalog row is refused as ungrantable, since no risk can be named for it (#1150)', () => {
      const noRow: ConsentCheckClassification = {
        decisions: new Map([
          [REQUIRED_CORE, classified()],
          [REQUIRED_DECLARED, classified()],
          [OPTIONAL_CORE, classified()],
        ]),
        currentRiskBySlug: new Map([
          [REQUIRED_DECLARED, RiskLevel.Low],
          [OPTIONAL_CORE, RiskLevel.Low],
        ]),
      };

      const error = thrown(() =>
        plan({ kind: 'SwitchOn', answers: [granted(REQUIRED_DECLARED)], classification: noRow }),
      );

      expect(error).toBeInstanceOf(PluginConsentActUngrantableError);
      expect(error).toMatchObject({ permissions: [{ permissionSlug: REQUIRED_CORE, cause: 'no_catalog_row' }] });
    });

    it('a permission whose catalog row is gone is refused as ungrantable, not as stale (#1150)', () => {
      const noRow: ConsentCheckClassification = {
        decisions: new Map([[OPTIONAL_CORE, classified({ ungrantable: 'no_catalog_row' })]]),
        currentRiskBySlug: new Map(),
      };

      const error = thrown(() =>
        plan({
          kind: 'Toggle',
          answers: [granted(OPTIONAL_CORE)],
          classification: noRow,
        }),
      );

      expect(error).toBeInstanceOf(PluginConsentActUngrantableError);
      expect(error).toMatchObject({ permissions: [{ permissionSlug: OPTIONAL_CORE, cause: 'no_catalog_row' }] });
    });

    it('a refusal of a permission whose catalog row is gone is refused as ungrantable, not as stale (#1150)', () => {
      const noRow: ConsentCheckClassification = {
        decisions: new Map([[OPTIONAL_CORE, classified({ ungrantable: 'no_catalog_row' })]]),
        currentRiskBySlug: new Map(),
      };

      const error = thrown(() => plan({ kind: 'Toggle', answers: [denied(OPTIONAL_CORE)], classification: noRow }));

      expect(error).toBeInstanceOf(PluginConsentActUngrantableError);
      expect(error).toMatchObject({ permissions: [{ permissionSlug: OPTIONAL_CORE, cause: 'no_catalog_row' }] });
    });
  });

  describe('the Server unit (#1336)', () => {
    const SERVER_OPTIONAL = 'read:game:public';
    const SERVER_RAISED = 'read:household:public';
    const HOUSEHOLD_ONLY = 'read:game_collection:public';
    const SERVER_CHECKS: readonly NormalizedPermissionRequest[] = [
      check(SERVER_OPTIONAL, { consentScope: 'server' }),
      check(SERVER_RAISED, { consentScope: 'server', required: true }),
      check(HOUSEHOLD_ONLY),
    ];
    const serverPlan = (overrides: Partial<PlanInput> & Pick<PlanInput, 'kind' | 'answers'>) =>
      plan({
        unit: SERVER_PLUGIN_UNIT,
        checks: SERVER_CHECKS,
        activeChecks: SERVER_CHECKS,
        classification: classification({
          slugs: [SERVER_OPTIONAL, SERVER_RAISED, HOUSEHOLD_ONLY],
          risks: { [SERVER_RAISED]: RiskLevel.High },
        }),
        ...overrides,
      });

    it('plans a toggle of an optional server-scope permission (#1336)', () => {
      const result = serverPlan({ kind: 'Toggle', answers: [denied(SERVER_OPTIONAL, RiskLevel.Low)] });

      expect(result.decisions).toEqual([
        { permissionSlug: SERVER_OPTIONAL, status: PluginGrantStatus.Denied, decidedRiskLevel: RiskLevel.Low },
      ]);
      expect(result.switchesOff).toBe(false);
    });

    it('plans a review that grants a risk-raised server-scope permission at the risk shown (#1336)', () => {
      const result = serverPlan({ kind: 'Review', answers: [granted(SERVER_RAISED, RiskLevel.High)] });

      expect(result.decisions[0]).toMatchObject({
        status: PluginGrantStatus.Granted,
        decidedRiskLevel: RiskLevel.High,
      });
    });

    it('refuses a server review that denies a required or an optional permission with the rule server-refusal (#1336)', () => {
      expectAnswerError(
        () => serverPlan({ kind: 'Review', answers: [denied(SERVER_RAISED, RiskLevel.High)] }),
        'server-refusal',
        [SERVER_RAISED],
      );
      expectAnswerError(
        () => serverPlan({ kind: 'Review', answers: [denied(SERVER_OPTIONAL, RiskLevel.Low)] }),
        'server-refusal',
        [SERVER_OPTIONAL],
      );
    });

    it('never reports switchesOff for the Server unit, since a server review cannot refuse (#1336)', () => {
      const result = serverPlan({ kind: 'Review', answers: [granted(SERVER_RAISED, RiskLevel.High)] });

      expect(result.switchesOff).toBe(false);
    });

    it('lists only server-scope permissions in the presentation (#1336)', () => {
      const result = serverPlan({ kind: 'Toggle', answers: [denied(SERVER_OPTIONAL, RiskLevel.Low)] });

      expect(result.presentation.checks.map((c) => c.slug)).toEqual([SERVER_OPTIONAL, SERVER_RAISED]);
    });
  });

  describe('presentation', () => {
    it('the presentation lists every permission the unit decides, in manifest order, with what was answered (#1150)', () => {
      const result = plan({
        kind: 'Review',
        answers: [denied(OPTIONAL_CORE), granted(REQUIRED_CORE)],
        locale: 'de',
      });

      expect(result.presentation).toEqual({
        locale: 'de',
        source: 'active',
        checks: [
          {
            slug: REQUIRED_CORE,
            required: true,
            feature: 'browse',
            riskLevel: RiskLevel.Low,
            reason: `Needed for ${REQUIRED_CORE}.`,
            usedFallback: true,
            outcome: 'granted',
          },
          {
            slug: REQUIRED_DECLARED,
            required: true,
            feature: null,
            riskLevel: RiskLevel.Low,
            reason: `Needed for ${REQUIRED_DECLARED}.`,
            usedFallback: true,
            outcome: 'unanswered',
          },
          {
            slug: OPTIONAL_CORE,
            required: false,
            feature: null,
            riskLevel: RiskLevel.Low,
            reason: `Needed for ${OPTIONAL_CORE}.`,
            usedFallback: true,
            outcome: 'refused',
          },
        ],
      });
      expect(result.presentation.checks.map((c) => c.slug)).not.toContain(SERVER_CHECK);
    });
  });
});
