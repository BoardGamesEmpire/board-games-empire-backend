/**
 * Rejection-class taxonomy for manifest validation (#59 "Validation at
 * install" steps 2–9). One code per class so the install endpoint, the
 * author CLI (#84), and the test matrix all speak the same vocabulary.
 * Structural (zod) failures map to `SCHEMA_INVALID` with the zod path/message
 * preserved per issue.
 */
export enum ManifestErrorCode {
  BGE_COMPAT_INVALID_RANGE = 'BGE_COMPAT_INVALID_RANGE',
  BGE_COMPAT_UNSATISFIED = 'BGE_COMPAT_UNSATISFIED',
  CORE_MODEL_NAME_INVALID = 'CORE_MODEL_NAME_INVALID',
  CRON_INVALID = 'CRON_INVALID',
  EVENT_EMIT_DUPLICATE = 'EVENT_EMIT_DUPLICATE',
  EVENT_EMIT_NAMESPACE = 'EVENT_EMIT_NAMESPACE',
  EVENT_NAME_INVALID = 'EVENT_NAME_INVALID',
  EVENT_SUBSCRIBE_DUPLICATE = 'EVENT_SUBSCRIBE_DUPLICATE',
  FEATURE_NAME_DUPLICATE = 'FEATURE_NAME_DUPLICATE',
  FEATURE_REF_UNKNOWN = 'FEATURE_REF_UNKNOWN',
  LOCALE_DEFAULT_MISSING = 'LOCALE_DEFAULT_MISSING',
  LOCALE_TAG_INVALID = 'LOCALE_TAG_INVALID',
  OUTBOUND_DOMAIN_DUPLICATE = 'OUTBOUND_DOMAIN_DUPLICATE',
  OUTBOUND_DOMAIN_INVALID = 'OUTBOUND_DOMAIN_INVALID',
  OWN_TABLE_DUPLICATE = 'OWN_TABLE_DUPLICATE',
  OWN_TABLE_PREFIX = 'OWN_TABLE_PREFIX',
  PERMISSION_CHECK_DUPLICATE = 'PERMISSION_CHECK_DUPLICATE',
  PERMISSION_CHECK_FOREIGN_NAMESPACE = 'PERMISSION_CHECK_FOREIGN_NAMESPACE',
  PERMISSION_CHECK_SHAPE = 'PERMISSION_CHECK_SHAPE',
  PERMISSION_CHECK_UNDECLARED = 'PERMISSION_CHECK_UNDECLARED',
  PERMISSION_DECLARE_DUPLICATE = 'PERMISSION_DECLARE_DUPLICATE',
  PERMISSION_DECLARE_NAMESPACE = 'PERMISSION_DECLARE_NAMESPACE',
  QUEUE_DUPLICATE = 'QUEUE_DUPLICATE',
  QUEUE_NAMESPACE = 'QUEUE_NAMESPACE',
  REASON_TRIVIAL = 'REASON_TRIVIAL',
  SCHEDULE_NAME_DUPLICATE = 'SCHEDULE_NAME_DUPLICATE',
  SCHEDULE_NAME_INVALID = 'SCHEDULE_NAME_INVALID',
  SCHEMA_INVALID = 'SCHEMA_INVALID',
  TOPIC_NAME_DUPLICATE = 'TOPIC_NAME_DUPLICATE',
  TOPIC_NAME_INVALID = 'TOPIC_NAME_INVALID',
  UPDATE_CHECK_URL_INVALID = 'UPDATE_CHECK_URL_INVALID',
  VERSION_INVALID = 'VERSION_INVALID',
}

/** Non-fatal author guidance surfaced by `bge-plugin validate` (#84 / D16). */
export enum ManifestWarningCode {
  REQUIRED_UNIT_SCOPE_PERMISSION = 'REQUIRED_UNIT_SCOPE_PERMISSION',
}

export interface ManifestIssue {
  readonly code: ManifestErrorCode;
  /** JSON-pointer-ish path into the manifest document, e.g. `permissions.checks[2].reason.de`. */
  readonly path: string;
  readonly message: string;
}

export interface ManifestWarning {
  readonly code: ManifestWarningCode;
  readonly path: string;
  readonly message: string;
}

/**
 * Collect-all aggregate: the validator never fails fast, so a plugin author
 * (or the install endpoint's structured-error response, #59) sees every
 * problem in one round trip instead of whack-a-mole.
 */
export class PluginManifestValidationError extends Error {
  public override readonly name = 'PluginManifestValidationError';

  constructor(public readonly issues: readonly ManifestIssue[]) {
    super(
      `Plugin manifest validation failed with ${issues.length} issue(s): ` +
        issues.map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`).join('; '),
    );
  }

  /** True when any issue carries the given rejection class. */
  public has(code: ManifestErrorCode): boolean {
    return this.issues.some((issue) => issue.code === code);
  }
}
