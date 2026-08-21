import { PluginGrantScope } from '@bge/database';
import * as pluginRuntime from '@bge/plugin';
import {
  type PluginConfigIssue,
  PluginConsentPresentationManifestError,
  PluginConsentPresentationNotFoundError,
  PluginConsentPresentationTombstonedError,
  PluginFeatureStateManifestError,
  PluginFeatureStateNotFoundError,
  PluginFeatureStateTombstonedError,
  PluginGrantAuthorityError,
  PluginGrantConsentScopeMismatchError,
  PluginGrantExclusionError,
  PluginGrantManifestInvalidError,
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
  PluginInstallProvenanceMismatchError,
  PluginInstallStaticAnalysisError,
  PluginInstallUnknownCorePermissionError,
  PluginStaticAnalysisUnavailableError,
  PluginUnitAuthorityError,
  PluginUnitConfigRequiredError,
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
  PluginUpdateProvenanceMismatchError,
  PluginUpdateStaticAnalysisError,
  PluginUpdateTombstonedError,
  PluginUpdateUnknownCorePermissionError,
  PluginUpdateVersionConflictError,
  StaticAnalysisFinding,
} from '@bge/plugin';
import { ManifestErrorCode, ManifestIssue } from '@boardgamesempire/plugin-manifest';
import { ArgumentsHost, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Http } from '@status/codes';
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

  beforeEach(() => {
    // Echo the key back so tests can assert which catalog message was chosen —
    // never the raw domain-error message (English-only, admin-log copy).
    translate = jest.fn((key: string) => `t:${key}`);
    filter = new PluginExceptionFilter({ translate } as never, { getLocale: () => 'en' } as never);
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
      [new PluginInstallPermissionCollisionError('sample', ['plugin|sample|sync']), 'install_permission_collision'],
    ] as const)('maps %s to 409', (exception, key) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.Conflict);
      expect(body()['message']).toBe(`t:errors.plugin.${key}`);
      expect(body()['code']).toBe(exception.name);
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
      [new PluginInstallProvenanceMismatchError('sample', 'bundled row, sideloaded directory')],
      [new PluginUpdateProvenanceMismatchError('sample', 'bundled row, sideloaded directory')],
    ])('maps %s to 500 without leaking the detail', (exception) => {
      filter.catch(exception, host);

      expect(rendered().getStatus()).toBe(Http.InternalServerError);
      expect(body()['message']).toBe('t:errors.plugin.state_corrupted');
      // The corruption detail stays in server logs (via cause), never the body.
      expect(JSON.stringify(body())).not.toContain('sideloaded');
      expect(Logger.prototype.error).toHaveBeenCalled();
    });

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

  describe('vocabulary completeness', () => {
    /**
     * Error classes the runtime exports that never surface through the
     * consent-collection endpoints this filter serves:
     * - the loader errors surface at boot and through #79 diagnostics — the
     *   loader quarantines instead of throwing to a request path;
     * - UnknownActorKindError guards the CLS actor projection inside plugin
     *   code paths, not a consent request.
     */
    const NON_CONSENT_SURFACE_ERRORS = new Set([
      'PluginDirectoryNotFoundError',
      'PluginDirectoryLayoutError',
      'PluginEntrypointError',
      'PluginModuleShapeError',
      'PluginEmitNotDeclaredError',
      'UnknownActorKindError',
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

      const caught = new Set(PLUGIN_EXCEPTION_FILTER_CATCHES.map((ctor) => ctor.name));

      // A new consent-surface error exported from @bge/plugin fails here until
      // this filter maps it — the status decision must be made, not defaulted.
      expect(exported.sort()).toEqual([...caught].sort());
    });
  });
});
