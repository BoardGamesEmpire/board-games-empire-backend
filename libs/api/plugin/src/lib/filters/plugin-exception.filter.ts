import { AuditContextService } from '@bge/actor-context';
import { I18nMessage, I18nPath, I18nTranslations, t, translateException } from '@bge/i18n';
import {
  PluginConfigSchemaUnusableError,
  PluginConfigValidationError,
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
  PluginInventoryManifestError,
  PluginInventoryNotFoundError,
  PluginInventoryTombstonedError,
  PluginLifecycleAuthorityError,
  PluginLifecycleManifestError,
  PluginLifecycleNotFoundError,
  PluginLifecycleTombstonedError,
  PluginStaticAnalysisUnavailableError,
  PluginUninstallBundledError,
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
} from '@bge/plugin';
import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Http } from '@status/codes';
import { I18nService } from 'nestjs-i18n';
import { STATUS_CODES } from 'node:http';

/**
 * How one plugin domain error renders over HTTP: the status, the localized
 * copy, and the machine-readable fields the response body carries BESIDE the
 * message. For the confirmation-challenge errors those fields are the
 * error's own prompt inputs — the client re-submits from them; the endpoint
 * never recomputes the expectation.
 *
 * Wire naming: when a body names the plugin's slug, the field is `slug`,
 * whatever the runtime error calls it (`slug` on install/update,
 * `pluginSlug` on grant/read errors) — one 410/422 client handler must work
 * for all of them. Since D-BO made the grant/consent paths slug-addressed,
 * every not-found body carries `slug` too; only the scope-shape errors
 * identify no plugin at all.
 *
 * `operatorActionable: true` marks errors an operator must act on —
 * server-state failures the caller cannot fix (provenance drift,
 * stored-manifest re-validation failure, a shadowed parser build): they log
 * loud at error level.
 */
interface PluginErrorRendering {
  status: Http;
  message: I18nMessage;
  fields?: Record<string, unknown>;
  operatorActionable?: boolean;
}

type ErrorCtor<E extends Error> = new (...args: never[]) => E;

type RendererMap = ReadonlyMap<ErrorCtor<Error>, (exception: Error) => PluginErrorRendering>;

/**
 * Assembles the class → rendering table in one expression, so the `@Catch`
 * list derived from its keys can never observe a partially-built map: a class
 * cannot be caught without a rendering or rendered without being caught, and
 * splitting renderings across files later cannot introduce an import-order
 * hazard without breaking this function's compile.
 */
function buildRenderers(): RendererMap {
  const map = new Map<ErrorCtor<Error>, (exception: Error) => PluginErrorRendering>();

  function renders<E extends Error>(ctor: ErrorCtor<E>, render: (exception: E) => PluginErrorRendering): void {
    map.set(ctor as ErrorCtor<Error>, render as (exception: Error) => PluginErrorRendering);
  }

  // Install and update raise the same rejection shapes with their own classes
  // and copy; these factories keep each pair's status and field set identical
  // by construction, so the two flows cannot drift apart field-by-field.

  const forbiddenPermission =
    (key: I18nPath) =>
    (
      exception: PluginInstallForbiddenPermissionError | PluginUpdateForbiddenPermissionError,
    ): PluginErrorRendering => ({
      status: Http.Forbidden,
      message: t(key, { permissionSlug: exception.permissionSlug }),
      fields: { slug: exception.slug, permissionSlug: exception.permissionSlug },
    });

  const criticalConfirmation =
    (key: I18nPath) =>
    (
      exception: PluginInstallCriticalConfirmationError | PluginUpdateCriticalConfirmationError,
    ): PluginErrorRendering => ({
      status: Http.Conflict,
      message: t(key),
      fields: {
        slug: exception.slug,
        expectedSlugs: exception.expectedSlugs,
        receivedSlugs: exception.receivedSlugs,
      },
    });

  const staticAnalysisChallenge =
    (key: I18nPath) =>
    (exception: PluginInstallStaticAnalysisError | PluginUpdateStaticAnalysisError): PluginErrorRendering => ({
      status: Http.Conflict,
      message: t(key),
      fields: {
        slug: exception.slug,
        findings: exception.findings,
        unacknowledgedSpecifiers: exception.unacknowledgedSpecifiers,
        unexpectedSpecifiers: exception.unexpectedSpecifiers,
      },
    });

  const unknownCorePermissions =
    (key: I18nPath) =>
    (
      exception: PluginInstallUnknownCorePermissionError | PluginUpdateUnknownCorePermissionError,
    ): PluginErrorRendering => ({
      status: Http.UnprocessableEntity,
      message: t(key),
      fields: { slug: exception.slug, missingSlugs: exception.missingSlugs },
    });

  const provenanceMismatch = (
    exception: PluginInstallProvenanceMismatchError | PluginUpdateProvenanceMismatchError,
  ): PluginErrorRendering => ({
    status: Http.InternalServerError,
    message: t('errors.plugin.state_corrupted'),
    fields: { slug: exception.slug },
    operatorActionable: true,
  });

  // The re-validation issues describe the plugin's own stored manifest, not
  // infrastructure state — admin-diagnosable, so they render (class docs on
  // the three stored-manifest errors say exactly this).
  const storedManifestInvalid = (
    exception:
      | PluginGrantManifestInvalidError
      | PluginFeatureStateManifestError
      | PluginConsentPresentationManifestError
      | PluginLifecycleManifestError
      | PluginUnitManifestError
      | PluginInventoryManifestError,
  ): PluginErrorRendering => ({
    status: Http.InternalServerError,
    message: t('errors.plugin.stored_manifest_invalid', { slug: exception.pluginSlug }),
    fields: { slug: exception.pluginSlug, issues: exception.issues ?? [] },
    operatorActionable: true,
  });

  // ─── 403 — authority failures and categorical exclusions ─────────────────

  renders(PluginInstallAuthorityError, () => ({
    status: Http.Forbidden,
    message: t('errors.plugin.install_authority'),
  }));

  renders(PluginUpdateAuthorityError, () => ({
    status: Http.Forbidden,
    message: t('errors.plugin.update_authority'),
  }));

  renders(PluginGrantAuthorityError, () => ({
    status: Http.Forbidden,
    message: t('errors.plugin.grant_authority'),
  }));

  renders(PluginLifecycleAuthorityError, () => ({
    status: Http.Forbidden,
    message: t('errors.plugin.lifecycle_authority'),
  }));

  renders(PluginUnitAuthorityError, () => ({
    status: Http.Forbidden,
    message: t('errors.plugin.unit_authority'),
  }));

  renders(PluginGrantExclusionError, (exception) => ({
    status: Http.Forbidden,
    message: t('errors.plugin.grant_exclusion', { permissionSlug: exception.permissionSlug }),
    fields: { permissionSlug: exception.permissionSlug },
  }));

  renders(PluginInstallForbiddenPermissionError, forbiddenPermission('errors.plugin.install_forbidden_permission'));
  renders(PluginUpdateForbiddenPermissionError, forbiddenPermission('errors.plugin.update_forbidden_permission'));

  // ─── 404 — unknown plugin ─────────────────────────────────────────────────

  renders(PluginUpdatePluginNotFoundError, (exception) => ({
    status: Http.NotFound,
    message: t('errors.plugin.update_not_found', { slug: exception.slug }),
    fields: { slug: exception.slug },
  }));

  renders(PluginGrantPluginNotFoundError, (exception) => ({
    status: Http.NotFound,
    message: t('errors.plugin.grant_plugin_not_found', { slug: exception.pluginSlug }),
    fields: { slug: exception.pluginSlug },
  }));

  renders(PluginConsentPresentationNotFoundError, (exception) => ({
    status: Http.NotFound,
    message: t('errors.plugin.presentation_not_found', { slug: exception.pluginSlug }),
    fields: { slug: exception.pluginSlug },
  }));

  renders(PluginLifecycleNotFoundError, (exception) => ({
    status: Http.NotFound,
    message: t('errors.plugin.lifecycle_not_found', { slug: exception.slug }),
    fields: { slug: exception.slug },
  }));

  renders(PluginUnitPluginNotFoundError, (exception) => ({
    status: Http.NotFound,
    message: t('errors.plugin.unit_plugin_not_found', { slug: exception.pluginSlug }),
    fields: { slug: exception.pluginSlug },
  }));

  // A unit with no enablement row is addressed state that does not exist —
  // a 404 on the unit, distinct from the plugin-level 404 above, and the
  // scopeType tells one client handler which axis to prompt for (enable
  // creates household rows; a user's row comes from their first Granted
  // consent).
  renders(PluginUnitNotEnrolledError, (exception) => ({
    status: Http.NotFound,
    message: t('errors.plugin.unit_not_enrolled', { slug: exception.pluginSlug }),
    fields: { slug: exception.pluginSlug, scopeType: exception.scopeType },
  }));

  renders(PluginFeatureStateNotFoundError, (exception) => ({
    status: Http.NotFound,
    message: t('errors.plugin.feature_state_not_found', { slug: exception.pluginSlug }),
    fields: { slug: exception.pluginSlug },
  }));

  renders(PluginInventoryNotFoundError, (exception) => ({
    status: Http.NotFound,
    message: t('errors.plugin.inventory_not_found', { slug: exception.pluginSlug }),
    fields: { slug: exception.pluginSlug },
  }));

  // ─── 410 — tombstoned (the record exists and says so; not a 404) ─────────

  renders(PluginUpdateTombstonedError, (exception) => ({
    status: Http.Gone,
    message: t('errors.plugin.update_tombstoned', { slug: exception.slug }),
    fields: { slug: exception.slug, uninstalledAt: exception.uninstalledAt },
  }));

  renders(PluginGrantPluginTombstonedError, (exception) => ({
    status: Http.Gone,
    message: t('errors.plugin.grant_tombstoned', { slug: exception.pluginSlug }),
    fields: { slug: exception.pluginSlug, uninstalledAt: exception.uninstalledAt },
  }));

  renders(PluginConsentPresentationTombstonedError, (exception) => ({
    status: Http.Gone,
    message: t('errors.plugin.presentation_tombstoned', { slug: exception.pluginSlug }),
    fields: { slug: exception.pluginSlug, uninstalledAt: exception.uninstalledAt },
  }));

  renders(PluginLifecycleTombstonedError, (exception) => ({
    status: Http.Gone,
    message: t('errors.plugin.lifecycle_tombstoned', { slug: exception.slug }),
    fields: { slug: exception.slug, uninstalledAt: exception.uninstalledAt },
  }));

  renders(PluginUnitPluginTombstonedError, (exception) => ({
    status: Http.Gone,
    message: t('errors.plugin.unit_plugin_tombstoned', { slug: exception.pluginSlug }),
    fields: { slug: exception.pluginSlug, uninstalledAt: exception.uninstalledAt },
  }));

  renders(PluginFeatureStateTombstonedError, (exception) => ({
    status: Http.Gone,
    message: t('errors.plugin.feature_state_tombstoned', { slug: exception.pluginSlug }),
    fields: { slug: exception.pluginSlug, uninstalledAt: exception.uninstalledAt },
  }));

  // Unconditional (D-CH): the list read takes an opt-in flag for tombstones,
  // the single read takes none. `uninstalledAt` rides along so the client can
  // say WHEN without a second request.
  renders(PluginInventoryTombstonedError, (exception) => ({
    status: Http.Gone,
    message: t('errors.plugin.inventory_tombstoned', { slug: exception.pluginSlug }),
    fields: { slug: exception.pluginSlug, uninstalledAt: exception.uninstalledAt },
  }));

  // ─── 409 — state conflicts ────────────────────────────────────────────────

  renders(PluginInstallConflictError, (exception) => ({
    status: Http.Conflict,
    message: t('errors.plugin.install_conflict', { slug: exception.slug }),
    fields: { slug: exception.slug },
  }));

  renders(PluginInstallPermissionCollisionError, (exception) => ({
    status: Http.Conflict,
    message: t('errors.plugin.install_permission_collision', { slug: exception.slug }),
    fields: { slug: exception.slug, collidingSlugs: exception.collidingSlugs },
  }));

  renders(PluginUpdateVersionConflictError, (exception) => ({
    status: Http.Conflict,
    message: t('errors.plugin.update_version_conflict', { slug: exception.slug, version: exception.version }),
    fields: { slug: exception.slug, version: exception.version },
  }));

  renders(PluginUpdatePendingConflictError, (exception) => ({
    status: Http.Conflict,
    message: t('errors.plugin.update_pending_conflict', {
      slug: exception.slug,
      pendingVersion: exception.pendingVersion,
      incomingVersion: exception.incomingVersion,
    }),
    fields: {
      slug: exception.slug,
      pendingVersion: exception.pendingVersion,
      incomingVersion: exception.incomingVersion,
    },
  }));

  renders(PluginUpdateNoPendingError, (exception) => ({
    status: Http.Conflict,
    message: t('errors.plugin.update_no_pending', { slug: exception.slug }),
    fields: { slug: exception.slug },
  }));

  renders(PluginUninstallBundledError, (exception) => ({
    status: Http.Conflict,
    message: t('errors.plugin.uninstall_bundled', { slug: exception.slug }),
    fields: { slug: exception.slug },
  }));

  // The enable-time config gate (#323): enable refused because required household config was
  // neither supplied nor retained in valid form. Curable state conflict,
  // not a validation error — the request itself was well-formed; `issues`
  // names what a RETAINED document violates (empty when none existed) so
  // the client's schema-driven form renders what to fix without a second
  // request.
  renders(PluginUnitConfigRequiredError, (exception) => ({
    status: Http.Conflict,
    message: t('errors.plugin.unit_config_required', { slug: exception.pluginSlug }),
    fields: { slug: exception.pluginSlug, issues: exception.issues },
  }));

  // An activation or a reinstall replaced the active manifest between the
  // request's read and its transaction, so every manifest-derived judgment
  // it made is stale. `kind` names which writer moved it — a reinstall also
  // purged consent, which the client may want to say out loud — and the
  // version pair makes the retry informed rather than a blind repeat. The
  // pair alone distinguishes nothing: it is equal for a same-version
  // reinstall AND for the A→B→A activation the content comparison catches
  // (#368), so `kind` is what says whether consent survived.
  renders(PluginUnitPluginChangedError, (exception) => ({
    status: Http.Conflict,
    message: t('errors.plugin.unit_plugin_changed', { slug: exception.pluginSlug }),
    fields: {
      slug: exception.pluginSlug,
      kind: exception.kind,
      expectedVersion: exception.expectedVersion,
      actualVersion: exception.actualVersion,
    },
  }));

  // ─── 409 — confirmation challenges (prompt inputs come FROM the error) ───

  renders(PluginInstallCriticalConfirmationError, criticalConfirmation('errors.plugin.install_critical_confirmation'));
  renders(PluginUpdateCriticalConfirmationError, criticalConfirmation('errors.plugin.update_critical_confirmation'));

  renders(PluginInstallStaticAnalysisError, staticAnalysisChallenge('errors.plugin.install_static_analysis'));
  renders(PluginUpdateStaticAnalysisError, staticAnalysisChallenge('errors.plugin.update_static_analysis'));

  renders(PluginUpdateBlockedByDenialError, (exception) => ({
    status: Http.Conflict,
    message: t('errors.plugin.update_blocked_by_denial'),
    fields: { slug: exception.slug, deniedRequiredSlugs: exception.deniedRequiredSlugs },
  }));

  // The decide()-side sibling of the denial block above (D-AV/D-BP, #322):
  // not a challenge — there is nothing to re-submit — but the same kind of
  // curable state conflict, and the client renders the two honest levers
  // (disable, uninstall) FROM this body, so its `code` and fields are
  // pinned (client repo #237).
  renders(PluginGrantRequiredDenialError, (exception) => ({
    status: Http.Conflict,
    message: t('errors.plugin.grant_required_denial', {
      slug: exception.pluginSlug,
      permissionSlug: exception.permissionSlug,
    }),
    fields: { slug: exception.pluginSlug, permissionSlug: exception.permissionSlug },
  }));

  // ─── 422 — manifest and semantic validation ───────────────────────────────

  renders(PluginInstallManifestError, (exception) => ({
    status: Http.UnprocessableEntity,
    message: t('errors.plugin.install_manifest', { slug: exception.slug }),
    fields: { slug: exception.slug, issues: exception.issues ?? [] },
  }));

  // The update error says WHICH manifest failed, and the mapping follows:
  // 'new' is the submitted manifest (a caller error, plain 422); 'pending'
  // is the stored staged manifest — rejecting the staged update clears the
  // state, so the request stays a 422, but the failure may be drift, so it
  // logs loud; 'active' is the stored active manifest, corrupted server
  // state the caller cannot touch — the same 500 contract as the three
  // stored-manifest read-path errors below.
  renders(PluginUpdateManifestError, (exception) =>
    exception.source === 'active'
      ? {
          status: Http.InternalServerError,
          message: t('errors.plugin.stored_manifest_invalid', { slug: exception.slug }),
          fields: { slug: exception.slug, source: exception.source, issues: exception.issues ?? [] },
          operatorActionable: true,
        }
      : {
          status: Http.UnprocessableEntity,
          message: t('errors.plugin.update_manifest', { slug: exception.slug }),
          fields: { slug: exception.slug, source: exception.source, issues: exception.issues ?? [] },
          operatorActionable: exception.source === 'pending',
        },
  );

  renders(
    PluginInstallUnknownCorePermissionError,
    unknownCorePermissions('errors.plugin.install_unknown_core_permissions'),
  );
  renders(
    PluginUpdateUnknownCorePermissionError,
    unknownCorePermissions('errors.plugin.update_unknown_core_permissions'),
  );

  renders(PluginGrantUnknownPermissionError, (exception) => ({
    status: Http.UnprocessableEntity,
    message: t('errors.plugin.grant_unknown_permission', { permissionSlug: exception.permissionSlug }),
    fields: { slug: exception.pluginSlug, permissionSlug: exception.permissionSlug },
  }));

  renders(PluginGrantConsentScopeMismatchError, (exception) => ({
    status: Http.UnprocessableEntity,
    message: t('errors.plugin.grant_consent_scope_mismatch', {
      permissionSlug: exception.permissionSlug,
      expected: exception.expected,
      received: exception.received,
    }),
    fields: {
      permissionSlug: exception.permissionSlug,
      expected: exception.expected,
      received: exception.received,
    },
  }));

  renders(PluginGrantScopeIdError, (exception) => ({
    status: Http.UnprocessableEntity,
    message: t('errors.plugin.grant_scope_id', { scopeType: exception.scopeType }),
    fields: { scopeType: exception.scopeType },
  }));

  renders(PluginGrantScopeNotRevocableError, (exception) => ({
    status: Http.UnprocessableEntity,
    message: t('errors.plugin.grant_scope_not_revocable', { scopeType: exception.scopeType }),
    fields: { scopeType: exception.scopeType },
  }));

  renders(PluginUnitScopeError, (exception) => ({
    status: Http.UnprocessableEntity,
    message: t('errors.plugin.unit_scope', { slug: exception.pluginSlug, scope: exception.scope }),
    fields: { slug: exception.pluginSlug, scope: exception.scope },
  }));

  renders(PluginConfigValidationError, (exception) => ({
    status: Http.UnprocessableEntity,
    message: t('errors.plugin.config_invalid', { slug: exception.slug }),
    fields: { slug: exception.slug, issues: exception.issues },
  }));

  // ─── 500 — corrupted server state (never a caller error; logged loud) ────

  renders(PluginInstallProvenanceMismatchError, provenanceMismatch);
  renders(PluginUpdateProvenanceMismatchError, provenanceMismatch);

  renders(PluginGrantManifestInvalidError, storedManifestInvalid);
  renders(PluginFeatureStateManifestError, storedManifestInvalid);
  renders(PluginConsentPresentationManifestError, storedManifestInvalid);
  renders(PluginLifecycleManifestError, storedManifestInvalid);
  renders(PluginUnitManifestError, storedManifestInvalid);
  // Reachable only from the SINGLE-plugin read: the list reads degrade the
  // offending row instead of raising (D-CG), so this 500 always describes a
  // response that had exactly one subject.
  renders(PluginInventoryManifestError, storedManifestInvalid);

  // A config.schema the server cannot compile passed manifest validation
  // (which never interprets it) and surfaced on first use — the plugin's
  // problem to ship fixed, the operator's to notice, never the caller's.
  renders(PluginConfigSchemaUnusableError, (exception) => ({
    status: Http.InternalServerError,
    message: t('errors.plugin.config_schema_unusable', { slug: exception.slug }),
    fields: { slug: exception.slug, version: exception.version },
    operatorActionable: true,
  }));

  // ─── 503 — static analysis unavailable (operator must act) ───────────────
  // Deliberately no Retry-After: a shadowed parser build never heals on its
  // own, so a backoff hint would be a lie — same choice as the storage
  // filter's misconfiguration 503s (its Retry-After is reserved for the
  // genuinely transient branch).

  renders(PluginStaticAnalysisUnavailableError, (exception) => ({
    status: Http.ServiceUnavailable,
    message: t('errors.plugin.static_analysis_unavailable'),
    fields: { failedCapabilities: exception.failedCapabilities, parserVersion: exception.parserVersion },
    operatorActionable: true,
  }));

  return map;
}

const renderers: RendererMap = buildRenderers();

/**
 * Every error class this filter maps, exported so the vocabulary-completeness
 * spec can assert that no consent-surface error the runtime exports is left
 * to fall through to a generic 500. Spec-only surface — deliberately NOT
 * re-exported from the lib barrel, so restructuring the registry stays a
 * file-local change.
 */
export const PLUGIN_EXCEPTION_FILTER_CATCHES: readonly ErrorCtor<Error>[] = [...renderers.keys()];

/**
 * Translates the plugin domain-error vocabulary (#59 Phase C4) into
 * HTTP statuses, mirroring StorageExceptionFilter: map only what we own,
 * delegate anything else to the base filter. The runtime lib's errors are
 * transport-agnostic on purpose — this filter is the single place the
 * status-code mapping lives.
 *
 * Response bodies are structured (`{ …fields, statusCode, message, error,
 * code }`): `code` is the domain error's `name` — a hand-pinned string
 * literal on every runtime error class, so it survives minification and
 * class renames — letting clients dispatch without parsing copy.
 * Prompt-bearing errors (Critical confirmation, static analysis, denial
 * blocks) spread their own machine-readable fields into the body so the
 * confirmation prompt is rendered FROM the error, never recomputed.
 * The raw English domain message is never surfaced — copy is a localized
 * `t()` marker — but the original error rides as `cause` for server-side
 * logs.
 *
 * Because this is a controller-scoped filter it runs *instead of* the global
 * `I18nExceptionFilter` (Nest picks the most specific matching filter), so it
 * resolves the marker itself via {@link translateException}.
 */
@Catch(...renderers.keys())
export class PluginExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(PluginExceptionFilter.name);

  constructor(
    private readonly i18n: I18nService<I18nTranslations>,
    private readonly auditContext: AuditContextService,
  ) {
    super();
  }

  override catch(exception: Error, host: ArgumentsHost): void {
    const render = this.resolveRenderer(exception);

    // Only reachable for an exception that instanceof-matches @Catch without
    // any mapped ancestor — impossible while the list derives from the map,
    // but the error path must degrade to the base filter, never crash.
    if (!render) {
      super.catch(exception, host);
      return;
    }

    const { status, message, fields, operatorActionable } = render(exception);

    if (operatorActionable) {
      // The domain message interpolates its own prose detail, but the
      // structured fields (issues[], failedCapabilities, …) don't all fit
      // it — carry them so the log is diagnosable without request replay.
      this.logger.error(
        `${exception.name}: ${exception.message}${fields ? ` ${JSON.stringify(fields)}` : ''}`,
        exception.stack,
      );
    }

    // Envelope keys last: a renderer field can never clobber the dispatch
    // contract (`code`) or the marker (`message`) — if a future field
    // collides, the envelope wins and the body stays translatable.
    const body = {
      ...fields,
      statusCode: status,
      message,
      error: STATUS_CODES[status] ?? exception.name,
      code: exception.name,
    };

    super.catch(
      translateException(new HttpException(body, status, { cause: exception }), this.i18n, this.auditContext),
      host,
    );
  }

  /**
   * `@Catch` matches by `instanceof`, so a SUBCLASS of a mapped error reaches
   * this filter even though it has no entry of its own (the reachable case:
   * a narrowed error declared outside `@bge/plugin`'s export surface, which
   * the vocabulary spec cannot see). Walk the prototype chain so it renders
   * as its nearest mapped ancestor instead of degrading to a generic 500.
   */
  private resolveRenderer(exception: Error): ((exception: Error) => PluginErrorRendering) | undefined {
    let ctor: unknown = exception.constructor;

    while (typeof ctor === 'function') {
      const render = renderers.get(ctor as ErrorCtor<Error>);
      if (render) {
        return render;
      }
      ctor = Object.getPrototypeOf(ctor);
    }

    return undefined;
  }
}
