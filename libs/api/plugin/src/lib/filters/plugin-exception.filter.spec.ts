import { Action, PluginGrantScope, ResourceType } from '@bge/database';
import * as pluginRuntime from '@bge/plugin';
import {
  type PluginConfigIssue,
  PluginConsentPresentationManifestError,
  PluginConsentPresentationNotFoundError,
  PluginConsentPresentationTombstonedError,
  PluginDirectoryLayoutError,
  PluginDirectoryNotFoundError,
  PluginFeatureStateManifestError,
  PluginFeatureStateNotFoundError,
  PluginFeatureStateTombstonedError,
  PluginGrantAuthorityError,
  PluginGrantConsentScopeMismatchError,
  PluginGrantExclusionError,
  PluginGrantHouseholdNotFoundError,
  PluginGrantManifestInvalidError,
  PluginGrantPluginChangedError,
  PluginGrantPluginNotFoundError,
  PluginGrantPluginTombstonedError,
  PluginGrantRequiredDenialError,
  PluginGrantScopeIdError,
  PluginGrantScopeNotRevocableError,
  PluginGrantUnknownPermissionError,
  PluginInstallAuthorityError,
  PluginInstallConflictError,
  PluginInstallCriticalConfirmationError,
  PluginInstallForbiddenPermissionError,
  PluginInstallManifestError,
  PluginInstallPermissionCollisionError,
  PluginInstallStaticAnalysisError,
  PluginInstallUnknownCorePermissionError,
  PluginLifecyclePluginChangedError,
  PluginReinstallConflictError,
  PluginStaticAnalysisUnavailableError,
  PluginUnitAuthorityError,
  PluginUnitConfigRequiredError,
  PluginUnitHouseholdNotFoundError,
  PluginUnitManifestError,
  PluginUnitNotEnrolledError,
  PluginUnitPluginChangedError,
  PluginUnitPluginNotFoundError,
  PluginUnitPluginTombstonedError,
  PluginUnitScopeError,
  PluginUpdateAuthorityError,
  PluginUpdateBlockedByDenialError,
  PluginUpdateCriticalConfirmationError,
  PluginUpdateForbiddenPermissionError,
  PluginUpdateManifestError,
  PluginUpdateNoPendingError,
  PluginUpdatePendingConflictError,
  PluginUpdatePluginNotFoundError,
  PluginUpdateStagingReplacedError,
  PluginUpdateStaticAnalysisError,
  PluginUpdateTombstonedError,
  PluginUpdateUnknownCorePermissionError,
  PluginUpdateVersionConflictError,
  StaticAnalysisFinding,
} from '@bge/plugin';
import * as pluginArtifacts from '@bge/plugin-artifacts';
import {
  PluginArchiveRefusedError,
  PluginArtifactChecksumMismatchError,
  PluginArtifactDownloadFailedError,
  PluginArtifactLinkRefusedError,
  PluginArtifactNotFoundError,
  PluginArtifactTooLargeError,
} from '@bge/plugin-artifacts';
import { ManifestErrorCode, ManifestIssue } from '@boardgamesempire/plugin-manifest';
import { ArgumentsHost, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Http } from '@status/codes';
import { PluginArtifactSourceError } from '../plugin-artifact-source.error';
import { PluginArtifactUploadInvalidError } from '../upload/plugin-artifact-upload-invalid.error';
import { PLUGIN_EXCEPTION_FILTER_CATCHES, PluginExceptionFilter } from './plugin-exception.filter';

const AXIOS_FINDING: StaticAnalysisFinding = {
  file: 'dist/index.js',
  kind: 'esm-import',
  specifier: 'axios',
  severity: 'forbidden',
  scanScope: 'default',
};

const SCHEMA_ISSUE: ManifestIssue = {
  code: ManifestErrorCode.BGE_COMPAT_UNSATISFIED,
  path: 'bgeCompat',
  message: 'range not satisfied',
};

const TOMBSTONED_AT = new Date('2026-08-01T00:00:00.000Z');

// A config-schema violation, NOT a manifest issue — the config gate carries
// ajv output (path/keyword/message), and the client's schema-driven form
// renders from it.
const CONFIG_ISSUE: PluginConfigIssue = {
  path: '/webhookUrl',
  keyword: 'required',
  message: "must have required property 'webhookUrl'",
};

describe('PluginExceptionFilter', () => {
  let filter: PluginExceptionFilter;
  let superCatch: jest.SpyInstance;
  let translate: jest.Mock;
  let host: ArgumentsHost;
  let getCurrentAbilities: jest.Mock;

  /** An ability that reads Household or not; the filter asks nothing else of it. */
  const ability = (readsHousehold: boolean) => ({
    can: (action: Action, subject: ResourceType) =>
      readsHousehold && action === Action.read && subject === ResourceType.Household,
  });

  beforeEach(() => {
    // Echo the key back so tests can assert which catalog message was chosen —
    // never the raw domain-error message (English-only, admin-log copy).
    translate = jest.fn((key: string) => `t:${key}`);
    // A user session by default: every ability reads Household.
    getCurrentAbilities = jest.fn(() => [ability(true)]);
    filter = new PluginExceptionFilter(
      { translate } as never,
      { getLocale: () => 'en' } as never,
      { getCurrentAbilities, getActingUserId: () => 'user-1' } as never,
    );
    superCatch = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    host = { switchToHttp: () => ({ getResponse: () => ({}) }) } as unknown as ArgumentsHost;
  });

  afterEach(() => jest.restoreAllMocks());

  // The filter re-issues a structured HttpException after translating the
  // marker `message`, so we assert the resolved status/body handed to the base
  // filter.
  const rendered = (): HttpException => superCatch.mock.calls[0][0] as HttpException;
  const body = (): Record<string, unknown> => rendered().getResponse() as Record<string, unknown>;

  describe('403 — authority and categorical exclusion', () => {
    it.each([
      [new PluginInstallAuthorityError('user-1'), 'install_authority'],
      [new PluginUpdateAuthorityError('user-1'), 'update_authority'],
      [new PluginGrantAuthorityError('user-1', 'not a household admin'), 'grant_authority'],
    ] as const)('maps %s to 403 with localized copy', (exception, key) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.Forbidden);
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['code']).toBe(exception.name);
      expect((rendered() as unknown as { cause?: unknown }).cause).toBe(exception);
    });

    it.each([
      [
        new PluginGrantExclusionError('manage:plugin', 'plugin-administration slugs are never grantable'),
        'grant_exclusion',
      ],
      [
        new PluginInstallForbiddenPermissionError('sample', 'manage:plugin', 'is a plugin-administration slug'),
        'install_forbidden_permission',
      ],
      [
        new PluginUpdateForbiddenPermissionError('sample', 'manage:plugin', 'is a plugin-administration slug'),
        'update_forbidden_permission',
      ],
    ] as const)('carries the offending permission slug on %s', (exception, key) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.Forbidden);
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['permissionSlug']).toBe('manage:plugin');
    });
  });

  describe('404 — unknown plugin', () => {
    it('maps PluginUpdatePluginNotFoundError to 404 with the slug', () => {
      filter.catch(new PluginUpdatePluginNotFoundError('sample'), host);

      expect(rendered().getStatus()).toBe(Http.NotFound);
      expect(body()['message']).toBe('t:errors.plugin.update_not_found');
      expect(body()['slug']).toBe('sample');
    });

    // Slug-addressed since D-BO: every not-found body carries `slug`.
    it.each([
      [new PluginGrantPluginNotFoundError('sample'), 'grant_plugin_not_found'],
      [new PluginConsentPresentationNotFoundError('sample'), 'presentation_not_found'],
    ] as const)('maps %s to 404 with the slug', (exception, key) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.NotFound);
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['slug']).toBe('sample');
    });
  });

  describe('410 — tombstoned (the record exists and says so, distinct from 404)', () => {
    const uninstalledAt = new Date('2026-08-01T00:00:00Z');

    // Wire naming is normalized: the plugin slug is `slug` in every body,
    // whatever the runtime error calls it — one client 410 handler for both.
    it.each([
      [new PluginUpdateTombstonedError('sample', uninstalledAt), 'update_tombstoned'],
      [new PluginGrantPluginTombstonedError('sample', uninstalledAt), 'grant_tombstoned'],
      [new PluginConsentPresentationTombstonedError('sample', uninstalledAt), 'presentation_tombstoned'],
    ] as const)('maps %s to 410 with the tombstone timestamp', (exception, key) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.Gone);
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['slug']).toBe('sample');
      expect(body()['uninstalledAt']).toBe(uninstalledAt);
    });
  });

  describe('409 — state conflicts', () => {
    it.each([
      [new PluginInstallConflictError('sample'), 'install_conflict'],
      [new PluginUpdateVersionConflictError('sample', '2.0.0'), 'update_version_conflict'],
      [new PluginUpdatePendingConflictError('sample', '2.0.0', '2.1.0'), 'update_pending_conflict'],
      [new PluginUpdateNoPendingError('sample'), 'update_no_pending'],
      [new PluginUpdateStagingReplacedError('sample', 'staging-a'), 'update_staging_replaced'],
      [new PluginInstallPermissionCollisionError('sample', ['plugin|sample|sync']), 'install_permission_collision'],
    ] as const)('maps %s to 409', (exception, key) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.Conflict);
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['code']).toBe(exception.name);
    });

    it('renders a lost reinstall race as 409 with its own copy and the slug, not the install-conflict copy (#1094)', () => {
      filter.catch(new PluginReinstallConflictError('sample'), host);

      expect(rendered().getStatus()).toBe(Http.Conflict);
      expect(body()['code']).toBe('PluginReinstallConflictError');
      expect(body()['message']).toBe('t:errors.plugin.reinstall_conflict');
      expect(body()['slug']).toBe('sample');
    });

    it('names the plugin and the staging the caller answered when that staging was replaced (#357)', () => {
      filter.catch(new PluginUpdateStagingReplacedError('sample', 'staging-a'), host);

      expect(rendered().getStatus()).toBe(Http.Conflict);
      expect(body()['code']).toBe('PluginUpdateStagingReplacedError');
      expect(body()['slug']).toBe('sample');
      expect(body()['stagingId']).toBe('staging-a');
    });

    it('carries staged and incoming versions on a pending conflict', () => {
      filter.catch(new PluginUpdatePendingConflictError('sample', '2.0.0', '2.1.0'), host);

      expect(body()['pendingVersion']).toBe('2.0.0');
      expect(body()['incomingVersion']).toBe('2.1.0');
    });
  });

  describe('409 — confirmation challenges (prompt inputs come FROM the error)', () => {
    it.each([
      [
        new PluginInstallCriticalConfirmationError('sample', ['manage:safe_http_policy'], []),
        'install_critical_confirmation',
      ],
      [
        new PluginUpdateCriticalConfirmationError('sample', ['manage:safe_http_policy'], ['stale:slug']),
        'update_critical_confirmation',
      ],
    ] as const)('renders the Critical re-entry prompt on %s', (exception, key) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.Conflict);
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['expectedSlugs']).toEqual(['manage:safe_http_policy']);
      expect(body()['receivedSlugs']).toEqual(exception.receivedSlugs);
    });

    it.each([
      [new PluginInstallStaticAnalysisError('sample', [AXIOS_FINDING], ['axios'], []), 'install_static_analysis'],
      [
        new PluginUpdateStaticAnalysisError('sample', [AXIOS_FINDING], ['axios'], ['left-pad']),
        'update_static_analysis',
      ],
    ] as const)('renders the acknowledgement prompt on %s', (exception, key) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.Conflict);
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['findings']).toEqual([AXIOS_FINDING]);
      expect(body()['unacknowledgedSpecifiers']).toEqual(['axios']);
      expect(body()['unexpectedSpecifiers']).toEqual(exception.unexpectedSpecifiers);
    });

    it('maps the D-AV required-denial refusal to 409 with the slug and permission — the lever prompt renders from this body', () => {
      filter.catch(new PluginGrantRequiredDenialError('sample', 'plugin|sample|manage:digest'), host);

      expect(rendered().getStatus()).toBe(Http.Conflict);
      expect(body()['message']).toBe('t:errors.plugin.grant_required_denial');
      expect(body()['slug']).toBe('sample');
      expect(body()['permissionSlug']).toBe('plugin|sample|manage:digest');
      expect(body()['code']).toBe('PluginGrantRequiredDenialError');
    });

    it('renders the blocking denials on PluginUpdateBlockedByDenialError', () => {
      filter.catch(new PluginUpdateBlockedByDenialError('sample', ['read:household']), host);

      expect(rendered().getStatus()).toBe(Http.Conflict);
      expect(body()['message']).toBe('t:errors.plugin.update_blocked_by_denial');
      expect(body()['deniedRequiredSlugs']).toEqual(['read:household']);
    });
  });

  describe('422 — manifest and semantic validation', () => {
    it.each([
      [new PluginInstallManifestError('sample', 'schema failed', [SCHEMA_ISSUE]), 'install_manifest'],
      [new PluginUpdateManifestError('sample', 'new', 'schema failed', [SCHEMA_ISSUE]), 'update_manifest'],
    ] as const)('carries the collect-all issues on %s', (exception, key) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.UnprocessableEntity);
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['issues']).toEqual([SCHEMA_ISSUE]);
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it('keeps a stored-PENDING manifest failure a 422 but logs it loud', () => {
      // Rejecting the staged update clears the state, so the request stays
      // caller-resolvable — but the failure may be drift, so operators hear it.
      filter.catch(
        new PluginUpdateManifestError('sample', 'pending', 'bgeCompat no longer satisfied', [SCHEMA_ISSUE]),
        host,
      );

      expect(rendered().getStatus()).toBe(Http.UnprocessableEntity);
      expect(body()['message']).toBe('t:errors.plugin.update_manifest');
      expect(body()['source']).toBe('pending');
      expect(Logger.prototype.error).toHaveBeenCalled();
    });

    it('maps a stored-ACTIVE manifest failure to 500 like the other stored-manifest errors', () => {
      filter.catch(new PluginUpdateManifestError('sample', 'active', 'row/manifest drift', [SCHEMA_ISSUE]), host);

      expect(rendered().getStatus()).toBe(Http.InternalServerError);
      expect(body()['message']).toBe('t:errors.plugin.stored_manifest_invalid');
      expect(body()['source']).toBe('active');
      expect(body()['issues']).toEqual([SCHEMA_ISSUE]);
      expect(Logger.prototype.error).toHaveBeenCalled();
    });

    it.each([
      [new PluginInstallUnknownCorePermissionError('sample', ['read:nope']), 'install_unknown_core_permissions'],
      [new PluginUpdateUnknownCorePermissionError('sample', ['read:nope']), 'update_unknown_core_permissions'],
    ] as const)('carries the collect-all missing slugs on %s', (exception, key) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.UnprocessableEntity);
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['missingSlugs']).toEqual(['read:nope']);
    });

    it.each([
      [
        new PluginGrantUnknownPermissionError('sample', 'read:nope', 'not requested by the manifest'),
        'grant_unknown_permission',
      ],
      [
        new PluginGrantConsentScopeMismatchError('read:household', PluginGrantScope.Household, PluginGrantScope.User),
        'grant_consent_scope_mismatch',
      ],
      [new PluginGrantScopeIdError(PluginGrantScope.Server, 'scopeId must be absent'), 'grant_scope_id'],
      [new PluginGrantScopeNotRevocableError(PluginGrantScope.Server), 'grant_scope_not_revocable'],
    ] as const)('maps %s to 422', (exception, key) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.UnprocessableEntity);
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['code']).toBe(exception.name);
    });
  });

  // The unit-enablement and feature-state families (#323) render statuses,
  // catalog keys, and body fields the clients build their levers from. The
  // vocabulary-completeness test below proves only that these classes reach
  // @Catch — it cannot catch a wrong status, a wrong key, or a dropped
  // field, so the renderings are asserted here (PR #363 review).
  describe('unit enablement and feature state (#323)', () => {
    it('maps the authority refusal to 403', () => {
      filter.catch(new PluginUnitAuthorityError('user-1'), host);

      expect(rendered().getStatus()).toBe(Http.Forbidden);
      expect(body()['message']).toBe('t:errors.plugin.unit_authority');
      expect(body()['code']).toBe('PluginUnitAuthorityError');
    });

    it.each([
      [new PluginUnitPluginNotFoundError('sample'), 'unit_plugin_not_found'],
      [new PluginFeatureStateNotFoundError('sample'), 'feature_state_not_found'],
    ] as const)('maps %s to 404 with the slug', (exception, key) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.NotFound);
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['slug']).toBe('sample');
      expect(body()['code']).toBe(exception.name);
    });

    it.each([
      ['unit write', new PluginUnitHouseholdNotFoundError('hh_1')],
      ['consent decision', new PluginGrantHouseholdNotFoundError('hh_1')],
    ] as const)(
      'maps a household deleted under a %s to 404 with the household copy the route guard gives (#548)',
      (_path, exception) => {
        filter.catch(exception, host);

        expect(rendered().getStatus()).toBe(Http.NotFound);
        // The same marker the household liveness guard answers with, so a
        // request that loses the race to a delete reads like one that arrived
        // after it.
        expect(body()['message']).toBe('t:errors.household.not_found');
        expect(body()['householdId']).toBe('hh_1');
        expect(body()['code']).toBe(exception.name);
      },
    );

    // The liveness guard's rule (#553), applied where the status is chosen: an
    // actor it passes through untouched was never told which households exist,
    // so losing the race to a delete must not tell it either.
    const HIDDEN = [
      { actor: 'an API key with no household read', abilities: () => [ability(true), ability(false)] },
      { actor: 'an actor with no abilities', abilities: () => [] },
    ];
    const REFUSED = [
      {
        exception: new PluginUnitHouseholdNotFoundError('hh_1'),
        key: 'unit_authority',
        code: 'PluginUnitAuthorityError',
      },
      {
        exception: new PluginGrantHouseholdNotFoundError('hh_1'),
        key: 'grant_authority',
        code: 'PluginGrantAuthorityError',
      },
    ];

    it.each(HIDDEN.flatMap((hidden) => REFUSED.map((refused) => ({ ...hidden, ...refused }))))(
      "answers $actor the admin check's 403 for a $exception.name",
      ({ abilities, exception, key, code }) => {
        getCurrentAbilities.mockImplementation(abilities);

        filter.catch(exception, host);

        expect(rendered().getStatus()).toBe(Http.Forbidden);
        expect(body()['message']).toBe(`t:errors.plugin.${key}`);
        expect(body()['code']).toBe(code);
        expect(body()).not.toHaveProperty('householdId');
        // The logs still see what happened.
        expect((rendered() as unknown as { cause?: unknown }).cause).toBe(exception);
      },
    );

    it('asks for the abilities only when a household was deleted, so the other errors render without them', () => {
      getCurrentAbilities.mockImplementation(() => {
        throw new Error('not primed');
      });

      filter.catch(new PluginUnitPluginNotFoundError('sample'), host);

      expect(rendered().getStatus()).toBe(Http.NotFound);
      expect(getCurrentAbilities).not.toHaveBeenCalled();
    });

    it('maps the not-enrolled 404 with the addressed axis, so the client knows WHICH unit has no row', () => {
      filter.catch(new PluginUnitNotEnrolledError('sample', 'Household'), host);

      expect(rendered().getStatus()).toBe(Http.NotFound);
      expect(body()['message']).toBe('t:errors.plugin.unit_not_enrolled');
      expect(body()['slug']).toBe('sample');
      expect(body()['scopeType']).toBe('Household');
    });

    it.each([
      [new PluginUnitPluginTombstonedError('sample', TOMBSTONED_AT), 'unit_plugin_tombstoned'],
      [new PluginFeatureStateTombstonedError('sample', TOMBSTONED_AT), 'feature_state_tombstoned'],
    ] as const)('maps %s to 410 carrying uninstalledAt', (exception, key) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.Gone);
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['uninstalledAt']).toEqual(TOMBSTONED_AT);
    });

    it('maps the config gate to 409 carrying issues[] — the client renders its form from them', () => {
      filter.catch(new PluginUnitConfigRequiredError('sample', [CONFIG_ISSUE]), host);

      expect(rendered().getStatus()).toBe(Http.Conflict);
      expect(body()['message']).toBe('t:errors.plugin.unit_config_required');
      expect(body()['slug']).toBe('sample');
      expect(body()['issues']).toEqual([CONFIG_ISSUE]);
    });

    it('the config gate renders an EMPTY issues[] rather than omitting it when nothing was retained', () => {
      filter.catch(new PluginUnitConfigRequiredError('sample', []), host);

      expect(body()['issues']).toEqual([]);
    });

    it('renders equal versions without implying a reinstall, for the A-B-A activation pair', () => {
      // #368: an activation away from and back to a version replaces the
      // manifest while leaving both discriminators where they were. The
      // version pair is equal here and the cause is still an activation, so
      // a client reading the pair to infer the cause would read it wrong —
      // `kind` is the field that answers whether consent survived.
      filter.catch(new PluginUnitPluginChangedError('sample', 'version-activated', '1.2.0', '1.2.0'), host);

      expect(rendered().getStatus()).toBe(Http.Conflict);
      expect(body()['kind']).toBe('version-activated');
      expect(body()['expectedVersion']).toBe('1.2.0');
      expect(body()['actualVersion']).toBe('1.2.0');
    });

    it('maps a mid-request activation to 409 naming both versions, so the retry is informed', () => {
      filter.catch(new PluginUnitPluginChangedError('sample', 'version-activated', '1.2.0', '1.3.0'), host);

      expect(rendered().getStatus()).toBe(Http.Conflict);
      expect(body()['message']).toBe('t:errors.plugin.unit_plugin_changed');
      expect(body()['kind']).toBe('version-activated');
      expect(body()['expectedVersion']).toBe('1.2.0');
      expect(body()['actualVersion']).toBe('1.3.0');
    });

    it('distinguishes a same-version reinstall by kind, since the version pair cannot', () => {
      filter.catch(new PluginUnitPluginChangedError('sample', 'reinstalled', '1.2.0', '1.2.0'), host);

      expect(rendered().getStatus()).toBe(Http.Conflict);
      expect(body()['kind']).toBe('reinstalled');
      expect(body()['expectedVersion']).toBe(body()['actualVersion']);
    });

    it('maps a config write against a moved plugin manifest to 409 naming the kind (#578)', () => {
      filter.catch(new PluginLifecyclePluginChangedError('sample', 'reinstalled', '1.2.0', '1.2.0'), host);

      expect(rendered().getStatus()).toBe(Http.Conflict);
      expect(body()['message']).toBe('t:errors.plugin.lifecycle_plugin_changed');
      expect(body()['slug']).toBe('sample');
      expect(body()['kind']).toBe('reinstalled');
      expect(body()['expectedVersion']).toBe('1.2.0');
      expect(body()['actualVersion']).toBe('1.2.0');
    });

    it('maps a decision against a moved plugin manifest to 409 naming the kind (#361)', () => {
      filter.catch(new PluginGrantPluginChangedError('sample', 'version-activated', '1.2.0', '1.3.0'), host);

      expect(rendered().getStatus()).toBe(Http.Conflict);
      expect(body()['message']).toBe('t:errors.plugin.grant_plugin_changed');
      expect(body()['slug']).toBe('sample');
      expect(body()['kind']).toBe('version-activated');
      expect(body()['expectedVersion']).toBe('1.2.0');
      expect(body()['actualVersion']).toBe('1.3.0');
    });

    it('maps the scope refusal to 422 with the offending scope', () => {
      filter.catch(new PluginUnitScopeError('sample', 'server'), host);

      expect(rendered().getStatus()).toBe(Http.UnprocessableEntity);
      expect(body()['message']).toBe('t:errors.plugin.unit_scope');
      expect(body()['slug']).toBe('sample');
    });

    it('maps a corrupt stored manifest on a unit write to 500, not to a caller error', () => {
      filter.catch(new PluginUnitManifestError('sample', 'schema drift', [SCHEMA_ISSUE]), host);

      expect(rendered().getStatus()).toBe(Http.InternalServerError);
      expect(body()['message']).toBe('t:errors.plugin.stored_manifest_invalid');
      expect(body()['issues']).toEqual([SCHEMA_ISSUE]);
    });
  });

  describe('500 — corrupted server state, logged loud, generic copy', () => {
    it.each([
      [new PluginGrantManifestInvalidError('sample', 'schema drift', [SCHEMA_ISSUE])],
      [new PluginFeatureStateManifestError('sample', 'schema drift', [SCHEMA_ISSUE])],
      [new PluginConsentPresentationManifestError('sample', 'schema drift', [SCHEMA_ISSUE])],
    ])('maps stored-manifest corruption %s to 500 carrying the issues', (exception) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.InternalServerError);
      expect(body()['message']).toBe('t:errors.plugin.stored_manifest_invalid');
      expect(body()['slug']).toBe('sample');
      // Admin-diagnosable: the re-validation issues describe the plugin's own
      // stored manifest, not infrastructure state — they render (class doc).
      expect(body()['issues']).toEqual([SCHEMA_ISSUE]);
      // ...and the operator log carries the structured fields, not just the
      // prose message — diagnosable without request replay.
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining('BGE_COMPAT_UNSATISFIED'),
        expect.any(String),
      );
    });
  });

  // The inventory reads, the staged update's approval and the install ingress
  // all reach the directory resolver, so its two errors reach requests too.
  describe("500 — a plugin's files on the server do not match its record (#1094)", () => {
    const placed = `/var/lib/bge/plugins/sample/${'a'.repeat(64)}`;

    it.each([
      [new PluginDirectoryLayoutError('sample', 'manifest.json at directory root is missing'), 'directory_layout'],
      [new PluginDirectoryNotFoundError('sample', placed), 'directory_not_found'],
    ] as const)('renders %s as 500 with its own code and copy, and logs it loud (#1094)', (exception, key) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.InternalServerError);
      expect(body()['code']).toBe(exception.name);
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['slug']).toBe('sample');
      expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining(exception.name), expect.any(String));
    });

    it('keeps the server path out of the body, for the log alone (#1094)', () => {
      filter.catch(new PluginDirectoryNotFoundError('sample', placed), host);

      expect(JSON.stringify(body())).not.toContain('/var/lib/bge');
      expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining(placed), expect.any(String));
    });
  });

  describe('delegation', () => {
    it('hands an unmapped error to the base filter untouched', () => {
      // Unreachable through @Catch (every caught class has a mapped ancestor),
      // but the error path must degrade, never crash — pin the fallback.
      const unmapped = new Error('not a plugin domain error');

      filter.catch(unmapped, host);

      expect(superCatch).toHaveBeenCalledWith(unmapped, host);
      expect(translate).not.toHaveBeenCalled();
    });
  });

  describe('subclass dispatch', () => {
    it('renders a subclass of a mapped error as its nearest mapped ancestor', () => {
      // The reachable miss case: a narrowed error declared OUTSIDE the
      // runtime's export surface — @Catch matches it by instanceof, and the
      // prototype walk must find the parent rendering instead of degrading
      // to the base filter's generic 500.
      class PluginUpdateManifestSchemaError extends PluginUpdateManifestError {}

      filter.catch(new PluginUpdateManifestSchemaError('sample', 'new', 'nested schema failure', [SCHEMA_ISSUE]), host);

      expect(rendered().getStatus()).toBe(Http.UnprocessableEntity);
      expect(body()['message']).toBe('t:errors.plugin.update_manifest');
      expect(body()['issues']).toEqual([SCHEMA_ISSUE]);
      // The runtime pins `name` as a literal instance field, so the subclass
      // inherits the ancestor's wire code — the dispatch contract stays stable.
      expect(body()['code']).toBe('PluginUpdateManifestError');
    });
  });

  describe('503 — static analysis unavailable (operator must act)', () => {
    it('maps PluginStaticAnalysisUnavailableError to 503 with the failed probes', () => {
      filter.catch(new PluginStaticAnalysisUnavailableError(['optional-chaining'], '1.9.15'), host);

      expect(rendered().getStatus()).toBe(Http.ServiceUnavailable);
      expect(body()['message']).toBe('t:errors.plugin.static_analysis_unavailable');
      expect(body()['failedCapabilities']).toEqual(['optional-chaining']);
      expect(body()['parserVersion']).toBe('1.9.15');
      expect(Logger.prototype.error).toHaveBeenCalled();
    });
  });

  describe('the install ingress: posting a plugin artifact and reading it back (#1094)', () => {
    it('renders a checksum mismatch as 422 with both checksums (#1094)', () => {
      filter.catch(new PluginArtifactChecksumMismatchError('a'.repeat(64), 'b'.repeat(64)), host);

      expect(rendered().getStatus()).toBe(Http.UnprocessableEntity);
      expect(body()['code']).toBe('PluginArtifactChecksumMismatchError');
      expect(body()['message']).toBe('t:errors.plugin.artifact_checksum_mismatch');
      expect(body()['expectedSha256']).toBe('a'.repeat(64));
      expect(body()['actualSha256']).toBe('b'.repeat(64));
    });

    it('renders an expected value that is not a checksum with a null actual checksum (#1094)', () => {
      filter.catch(new PluginArtifactChecksumMismatchError('nope', null), host);

      expect(rendered().getStatus()).toBe(Http.UnprocessableEntity);
      expect(body()['actualSha256']).toBeNull();
    });

    it('renders a plugin artifact over the limit as 413 with the limit (#1094)', () => {
      filter.catch(new PluginArtifactTooLargeError(104857600), host);

      expect(rendered().getStatus()).toBe(Http.PayloadTooLarge);
      expect(body()['code']).toBe('PluginArtifactTooLargeError');
      expect(body()['message']).toBe('t:errors.plugin.artifact_too_large');
      expect(body()['limitBytes']).toBe(104857600);
    });

    it.each([
      ['invalid-link', 'artifact_link_refused_invalid_link'],
      ['blocked-by-policy', 'artifact_link_refused_blocked_by_policy'],
      ['redirect-blocked', 'artifact_link_refused_redirect_blocked'],
      ['too-many-redirects', 'artifact_link_refused_too_many_redirects'],
    ] as const)('says why a %s link was refused, as 422 (#1094)', (reason, key) => {
      filter.catch(new PluginArtifactLinkRefusedError(reason), host);

      expect(rendered().getStatus()).toBe(Http.UnprocessableEntity);
      expect(body()['code']).toBe('PluginArtifactLinkRefusedError');
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['reason']).toBe(reason);
    });

    it.each([
      ['upstream-status', 404, 'artifact_download_failed_upstream_status'],
      ['unreachable', null, 'artifact_download_failed_unreachable'],
      ['timeout', null, 'artifact_download_failed_timeout'],
    ] as const)('says why a %s download failed, as 502 (#1094)', (reason, upstreamStatus, key) => {
      filter.catch(new PluginArtifactDownloadFailedError(reason, upstreamStatus), host);

      expect(rendered().getStatus()).toBe(Http.BadGateway);
      expect(body()['code']).toBe('PluginArtifactDownloadFailedError');
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['reason']).toBe(reason);
      expect(body()['upstreamStatus']).toBe(upstreamStatus);
      expect(translate).toHaveBeenCalledWith(
        expect.stringContaining(`errors.plugin.${key}`),
        expect.objectContaining({ args: { upstreamStatus } }),
      );
    });

    it('cuts an archive entry name to 200 characters in the body (#1094)', () => {
      filter.catch(new PluginArchiveRefusedError('unsafe-path', '../'.repeat(300)), host);

      expect((body()['entry'] as string).length).toBe(200);
    });

    it('renders an unknown plugin artifact as 404 with the checksum asked for (#1094)', () => {
      filter.catch(new PluginArtifactNotFoundError('c'.repeat(64)), host);

      expect(rendered().getStatus()).toBe(Http.NotFound);
      expect(body()['code']).toBe('PluginArtifactNotFoundError');
      expect(body()['message']).toBe('t:errors.plugin.artifact_not_found');
      expect(body()['sha256']).toBe('c'.repeat(64));
    });

    it.each([
      ['none', 'artifact_source'],
      ['both', 'artifact_source'],
    ] as const)('renders a request with %s of link and file as 400 (#1094)', (reason, key) => {
      filter.catch(new PluginArtifactSourceError(reason), host);

      expect(rendered().getStatus()).toBe(Http.BadRequest);
      expect(body()['code']).toBe('PluginArtifactSourceError');
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['reason']).toBe(reason);
    });

    it("renders an upload in a form the route does not take as 400 with localized copy, never multer's (#1094)", () => {
      filter.catch(new PluginArtifactUploadInvalidError({ cause: new Error('Unexpected field - other') }), host);

      expect(rendered().getStatus()).toBe(Http.BadRequest);
      expect(body()['code']).toBe('PluginArtifactUploadInvalidError');
      expect(body()['message']).toBe('t:errors.plugin.artifact_upload_invalid');
      expect(JSON.stringify(body())).not.toContain('Unexpected field');
    });

    it('says which archive rule refused it (#1094)', () => {
      filter.catch(new PluginArchiveRefusedError('unsafe-path', '../x'), host);

      expect(rendered().getStatus()).toBe(Http.UnprocessableEntity);
      expect(body()['code']).toBe('PluginArchiveRefusedError');
      expect(body()['message']).toBe('t:errors.plugin.artifact_archive_unsafe_path');
      expect(body()['fields']).toBeUndefined();
      expect(body()['rule']).toBe('unsafe-path');
      expect(body()['entry']).toBe('../x');
    });

    it.each([
      ['not-gzip', 'artifact_archive_not_gzip'],
      ['corrupt', 'artifact_archive_corrupt'],
      ['entry-type', 'artifact_archive_entry_type'],
      ['unsafe-path', 'artifact_archive_unsafe_path'],
      ['top-level', 'artifact_archive_top_level'],
      ['entry-count', 'artifact_archive_entry_count'],
      ['extracted-size', 'artifact_archive_extracted_size'],
      ['compressed-size', 'artifact_archive_compressed_size'],
      ['required-file', 'artifact_archive_required_file'],
      ['manifest-slug', 'artifact_archive_manifest_slug'],
      ['manifest-size', 'artifact_archive_manifest_size'],
    ] as const)('has its own copy for the %s archive rule (#1094)', (rule, key) => {
      filter.catch(new PluginArchiveRefusedError(rule), host);

      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['rule']).toBe(rule);
    });
  });

  describe('vocabulary completeness', () => {
    /**
     * Error classes the runtime exports that never surface through the
     * consent-collection endpoints this filter serves:
     * - the loader errors below surface at boot and through #79 diagnostics —
     *   the loader quarantines instead of throwing to a request path. The two
     *   directory errors are not among them: the plugin inventory, the staged
     *   update's approval and the install ingress reach the directory
     *   resolver, so this filter maps both (#1094);
     * - UnknownActorKindError guards the CLS actor projection inside plugin
     *   code paths, not a consent request.
     */
    const NON_CONSENT_SURFACE_ERRORS = new Set([
      'PluginEntrypointError',
      'PluginModuleShapeError',
      'PluginDiskVersionMismatchError',
      'PluginEmitNotDeclaredError',
      'UnknownActorKindError',
    ]);

    const artifactErrors = (): string[] =>
      Object.entries(pluginArtifacts)
        .filter(
          ([, candidate]) =>
            typeof candidate === 'function' && (candidate as { prototype?: unknown }).prototype instanceof Error,
        )
        .map(([exportName]) => exportName);

    const INSTALL_INGRESS_ERRORS = new Set([
      ...artifactErrors(),
      PluginArtifactSourceError.name,
      PluginArtifactUploadInvalidError.name,
    ]);

    it('maps every consent-surface error class the runtime exports', () => {
      // Every exported Error subclass, whatever it is named — a name-pattern
      // filter would let an unconventionally-named error skip the guard.
      const exported = Object.entries(pluginRuntime)
        .filter(
          ([, candidate]) =>
            typeof candidate === 'function' && (candidate as { prototype?: unknown }).prototype instanceof Error,
        )
        .map(([exportName]) => exportName)
        .filter((exportName) => !NON_CONSENT_SURFACE_ERRORS.has(exportName));

      // The install ingress's own classes have their completeness test below.
      const caught = new Set(
        PLUGIN_EXCEPTION_FILTER_CATCHES.map((ctor) => ctor.name).filter((name) => !INSTALL_INGRESS_ERRORS.has(name)),
      );

      // A new consent-surface error exported from @bge/plugin fails here until
      // this filter maps it — the status decision must be made, not defaulted.
      expect(exported.sort()).toEqual([...caught].sort());
    });
  });

  describe('install ingress completeness (#1094)', () => {
    it('catches every Error class the plugin artifacts lib exports, and the API lib source and upload errors (#1094)', () => {
      const exported = Object.entries(pluginArtifacts)
        .filter(
          ([, candidate]) =>
            typeof candidate === 'function' && (candidate as { prototype?: unknown }).prototype instanceof Error,
        )
        .map(([exportName]) => exportName);
      const caught = new Set(PLUGIN_EXCEPTION_FILTER_CATCHES.map((ctor) => ctor.name));

      expect(exported.length).toBeGreaterThan(0);
      // Collected, so a failure names the class that was left unmapped.
      const unmapped = [...exported, PluginArtifactSourceError.name, PluginArtifactUploadInvalidError.name].filter(
        (name) => !caught.has(name),
      );
      expect(unmapped).toEqual([]);
    });
  });
});
