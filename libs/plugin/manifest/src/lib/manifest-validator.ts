import { satisfies, valid, validRange } from 'semver';
import {
  CRON_FIELD_PATTERN,
  DEFAULT_MIN_REASON_LENGTH,
  EVENT_NAME_PATTERN,
  IDENTIFIER_PATTERN,
  LOW_EFFORT_REASON_PATTERN,
  OWN_TABLE_SUFFIX_PATTERN,
  pluginEmitPrefix,
  pluginPermissionPrefix,
  pluginQueuePrefix,
  pluginTablePrefix,
} from './constants.js';
import {
  ManifestErrorCode,
  ManifestIssue,
  ManifestWarning,
  ManifestWarningCode,
  PluginManifestValidationError,
} from './errors.js';
import { canonicalizeLocale, isWellFormedBcp47, LocalizedString } from './localized-string.js';
import { pluginManifestSchema } from './manifest.schema.js';
import type { NormalizedPermissionRequest, PluginManifest, PluginManifestValidationResult } from './manifest.types.js';

export interface ManifestValidationOptions {
  /**
   * The running BGE version (build-time injected, see D-D) that `bgeCompat` must satisfy.
   */
  readonly bgeVersion: string;

  /**
   * Server's configured default locale — every localized map must contain it.
   */
  readonly defaultLocale: string;

  /**
   * Minimum trimmed length for permission `reason` values.
   */
  readonly minReasonLength?: number;
}

/**
 * RFC-1035-shaped FQDN: dot-separated labels, alphanumeric with interior
 * hyphens, alphabetic TLD (punycode `xn--` satisfies the label charset).
 * Uppercase, schemes, ports, paths, IP literals, and wildcards are all
 * rejected — `SafeHttpService` (#55) enforcement is exact-host, and a
 * wildcard grant is a consent-surface change that belongs in an explicit
 * future manifest revision, not in lenient parsing.
 */
const FQDN_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:xn--[a-z0-9-]{2,59}|[a-z]{2,63})$/;

// Core permission slug shape, matched against the seeded `Permission.slug`
// vocabulary (prisma/seeds/roles-permissions.seed.ts): a verb segment plus
// one or more colon-delimited segments, each lowercase and allowing interior
// `_`/`-` (e.g. `read:public_content`, `update:event_occurrence:confirm`).
// Existence in the Permission table is a Phase C install-pipeline check; this
// only gates the SHAPE so a plugin-namespaced slug isn't misfiled as core.
// `plugin:`-prefixed slugs are routed by PLUGIN_NAMESPACE_PATTERN before this
// is consulted, so the leading segment can never collide with the namespace.
const CORE_PERMISSION_SLUG_PATTERN = /^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)+$/;
const PLUGIN_NAMESPACE_PATTERN = /^plugin:/;

/**
 * Structural (zod) paths rendered in the same bracket notation the semantic
 * pass emits (`permissions.checks[0].slug`, not `permissions.checks.0.slug`)
 * so CLI/UI consumers can highlight fields with one parser.
 */
const formatIssuePath = (segments: ReadonlyArray<PropertyKey>): string => {
  const path = segments.reduce<string>((accumulated, segment) => {
    if (typeof segment === 'number') {
      return `${accumulated}[${segment}]`;
    }

    return accumulated === '' ? String(segment) : `${accumulated}.${String(segment)}`;
  }, '');

  return path === '' ? '<root>' : path;
};

interface LocalizedField {
  readonly path: string;
  readonly value: LocalizedString;
}

const collectLocalizedFields = (manifest: PluginManifest): readonly LocalizedField[] => {
  const fields: LocalizedField[] = [
    { path: 'displayName', value: manifest.displayName },
    { path: 'description', value: manifest.description },
  ];

  manifest.features.forEach((feature, index) => {
    fields.push({ path: `features[${index}].displayName`, value: feature.displayName });
    fields.push({ path: `features[${index}].description`, value: feature.description });
  });

  manifest.permissions.checks.forEach((check, index) => {
    fields.push({ path: `permissions.checks[${index}].reason`, value: check.reason });
  });

  manifest.topics.forEach((topic, index) => {
    fields.push({ path: `topics[${index}].displayName`, value: topic.displayName });
    fields.push({ path: `topics[${index}].description`, value: topic.description });
  });

  return fields;
};

const eachDuplicate = (values: readonly string[], onDuplicate: (value: string, index: number) => void): void => {
  const seen = new Set<string>();

  values.forEach((value, index) => {
    if (seen.has(value)) {
      onDuplicate(value, index);
    }

    seen.add(value);
  });
};

const isTrivialReason = (text: string, minLength: number): boolean => {
  const trimmed = text.trim();

  return trimmed.length < minLength || LOW_EFFORT_REASON_PATTERN.test(trimmed);
};

/**
 * Full manifest validation: structural (zod) pass mapped to `SCHEMA_INVALID`
 * issues, then the semantic second pass covering #59 install-validation
 * steps 2–9. Collect-all by design — every issue in one throw.
 *
 * Deliberately NOT here (they need the database or the tarball and belong to
 * the install pipeline, Phase C / #84): `declares[]` collision against the
 * `Permission` table, existence of external `checks[].slug` entries
 * (surfaced via `externalPermissionChecks`), admin denial of required
 * permissions (#60), installer authority, static analysis, npm audit.
 */
export const validatePluginManifest = (
  input: unknown,
  options: ManifestValidationOptions,
): PluginManifestValidationResult => {
  const parsed = pluginManifestSchema.safeParse(input);

  if (!parsed.success) {
    throw new PluginManifestValidationError(
      parsed.error.issues.map(
        (issue): ManifestIssue => ({
          code: ManifestErrorCode.SCHEMA_INVALID,
          path: formatIssuePath(issue.path),
          message: issue.message,
        }),
      ),
    );
  }

  if (!isWellFormedBcp47(options.defaultLocale)) {
    throw new RangeError(
      `ManifestValidationOptions.defaultLocale '${options.defaultLocale}' is not a well-formed BCP 47 tag — server misconfiguration, not a manifest issue`,
    );
  }

  const manifest = parsed.data;
  const issues: ManifestIssue[] = [];
  const warnings: ManifestWarning[] = [];
  const minReasonLength = options.minReasonLength ?? DEFAULT_MIN_REASON_LENGTH;
  const push = (code: ManifestErrorCode, path: string, message: string): void => {
    issues.push({ code, path, message });
  };

  // ── version / bgeCompat ────────────────────────────────────────────────
  if (valid(manifest.version) === null) {
    push(ManifestErrorCode.VERSION_INVALID, 'version', `'${manifest.version}' is not a valid semver version`);
  }

  if (validRange(manifest.bgeCompat) === null) {
    push(
      ManifestErrorCode.BGE_COMPAT_INVALID_RANGE,
      'bgeCompat',
      `'${manifest.bgeCompat}' is not a valid semver range`,
    );
  } else if (!satisfies(options.bgeVersion, manifest.bgeCompat, { includePrerelease: true })) {
    push(
      ManifestErrorCode.BGE_COMPAT_UNSATISFIED,
      'bgeCompat',
      `BGE ${options.bgeVersion} does not satisfy required range '${manifest.bgeCompat}'`,
    );
  }

  const canonicalDefaultLocale = canonicalizeLocale(options.defaultLocale);
  // ── localization (issue "Localization rules") ──────────────────────────
  for (const field of collectLocalizedFields(manifest)) {
    if (typeof field.value === 'string') {
      continue;
    }

    const tags = Object.keys(field.value);

    for (const tag of tags) {
      if (!isWellFormedBcp47(tag)) {
        push(ManifestErrorCode.LOCALE_TAG_INVALID, `${field.path}.${tag}`, `'${tag}' is not a well-formed BCP 47 tag`);
      }
    }

    const containsDefault = tags.some(
      (tag) => isWellFormedBcp47(tag) && canonicalizeLocale(tag) === canonicalDefaultLocale,
    );

    if (!containsDefault) {
      push(
        ManifestErrorCode.LOCALE_DEFAULT_MISSING,
        field.path,
        `Localized map must include the configured default locale '${options.defaultLocale}'`,
      );
    }
  }

  // ── permissions.declares namespacing (#59 step 3) ──────────────────────
  const ownPrefix = pluginPermissionPrefix(manifest.slug);

  manifest.permissions.declares.forEach((slug, index) => {
    if (!slug.startsWith(ownPrefix) || slug.length === ownPrefix.length) {
      push(
        ManifestErrorCode.PERMISSION_DECLARE_NAMESPACE,
        `permissions.declares[${index}]`,
        `'${slug}' must be namespaced under '${ownPrefix}'`,
      );
    }
  });

  eachDuplicate(manifest.permissions.declares, (slug, index) => {
    push(
      ManifestErrorCode.PERMISSION_DECLARE_DUPLICATE,
      `permissions.declares[${index}]`,
      `'${slug}' declared more than once`,
    );
  });

  // ── permissions.checks ─────────────────────────────────────────────────
  const declared = new Set(manifest.permissions.declares);
  const featureNames = new Set(manifest.features.map((feature) => feature.name));
  const externalPermissionChecks: string[] = [];
  const permissionChecks: NormalizedPermissionRequest[] = [];

  manifest.permissions.checks.forEach((check, index) => {
    const path = `permissions.checks[${index}]`;
    const consentScope = check.consentScope ?? 'server';

    permissionChecks.push({ ...check, consentScope });

    if (PLUGIN_NAMESPACE_PATTERN.test(check.slug)) {
      if (!check.slug.startsWith(ownPrefix)) {
        push(
          ManifestErrorCode.PERMISSION_CHECK_FOREIGN_NAMESPACE,
          `${path}.slug`,
          `'${check.slug}' targets another plugin's namespace; cross-plugin permission checks are not supported`,
        );
      } else if (!declared.has(check.slug)) {
        push(
          ManifestErrorCode.PERMISSION_CHECK_UNDECLARED,
          `${path}.slug`,
          `'${check.slug}' is in this plugin's namespace but missing from permissions.declares`,
        );
      }
    } else if (!CORE_PERMISSION_SLUG_PATTERN.test(check.slug)) {
      push(
        ManifestErrorCode.PERMISSION_CHECK_SHAPE,
        `${path}.slug`,
        `'${check.slug}' is neither plugin-namespaced nor shaped like a core permission slug (e.g. 'game:read')`,
      );
    } else {
      externalPermissionChecks.push(check.slug);
    }

    if (check.feature !== undefined && !featureNames.has(check.feature)) {
      push(
        ManifestErrorCode.FEATURE_REF_UNKNOWN,
        `${path}.feature`,
        `'${check.feature}' does not match any features[].name`,
      );
    }

    if (typeof check.reason === 'string') {
      if (isTrivialReason(check.reason, minReasonLength)) {
        push(
          ManifestErrorCode.REASON_TRIVIAL,
          `${path}.reason`,
          `Reason must be a meaningful explanation (min ${minReasonLength} chars)`,
        );
      }
    } else {
      for (const [tag, text] of Object.entries(check.reason)) {
        if (isTrivialReason(text, minReasonLength)) {
          push(
            ManifestErrorCode.REASON_TRIVIAL,
            `${path}.reason.${tag}`,
            `Reason for locale '${tag}' must be a meaningful explanation (min ${minReasonLength} chars)`,
          );
        }
      }
    }

    if (check.required && consentScope !== 'server') {
      warnings.push({
        code: ManifestWarningCode.REQUIRED_UNIT_SCOPE_PERMISSION,
        path,
        message:
          `'${check.slug}' is required at '${consentScope}' consent scope: introducing or promoting such a permission ` +
          'is a per-unit breaking change (semver-major) and will auto-disable the plugin for non-consenting units (#59)',
      });
    }
  });

  eachDuplicate(
    manifest.permissions.checks.map((check) => check.slug),
    (slug, index) => {
      push(
        ManifestErrorCode.PERMISSION_CHECK_DUPLICATE,
        `permissions.checks[${index}].slug`,
        `'${slug}' requested more than once`,
      );
    },
  );

  // ── features ───────────────────────────────────────────────────────────
  eachDuplicate(
    manifest.features.map((feature) => feature.name),
    (name, index) => {
      push(ManifestErrorCode.FEATURE_NAME_DUPLICATE, `features[${index}].name`, `Feature name '${name}' is duplicated`);
    },
  );

  // ── network.outboundDomains (#59 step 6) ───────────────────────────────
  if (manifest.network.outboundDomains !== 'configured') {
    manifest.network.outboundDomains.forEach((domain, index) => {
      if (!FQDN_PATTERN.test(domain)) {
        push(
          ManifestErrorCode.OUTBOUND_DOMAIN_INVALID,
          `network.outboundDomains[${index}]`,
          `'${domain}' is not a bare lowercase FQDN (no scheme, port, path, wildcard, or IP literal)`,
        );
      }
    });

    eachDuplicate(manifest.network.outboundDomains, (domain, index) => {
      push(
        ManifestErrorCode.OUTBOUND_DOMAIN_DUPLICATE,
        `network.outboundDomains[${index}]`,
        `'${domain}' listed more than once`,
      );
    });
  }

  // ── topics (#196 manifest surface) ─────────────────────────────────────
  eachDuplicate(
    manifest.topics.map((topic) => topic.name),
    (name, index) => {
      push(
        ManifestErrorCode.TOPIC_NAME_DUPLICATE,
        `topics[${index}].name`,
        `Topic '${name}' is declared more than once`,
      );
    },
  );

  // ── events ─────────────────────────────────────────────────────────────
  const emitPrefix = pluginEmitPrefix(manifest.slug);

  eachDuplicate(manifest.events.subscribes, (pattern, index) => {
    push(
      ManifestErrorCode.EVENT_SUBSCRIBE_DUPLICATE,
      `events.subscribes[${index}]`,
      `'${pattern}' listed more than once`,
    );
  });

  eachDuplicate(manifest.events.emits, (eventName, index) => {
    push(ManifestErrorCode.EVENT_EMIT_DUPLICATE, `events.emits[${index}]`, `'${eventName}' listed more than once`);
  });

  manifest.events.emits.forEach((eventName, index) => {
    if (!EVENT_NAME_PATTERN.test(eventName)) {
      push(
        ManifestErrorCode.EVENT_NAME_INVALID,
        `events.emits[${index}]`,
        `'${eventName}' is not a valid dotted event name`,
      );
    } else if (!eventName.startsWith(emitPrefix)) {
      push(
        ManifestErrorCode.EVENT_EMIT_NAMESPACE,
        `events.emits[${index}]`,
        `Emitted events must be namespaced under '${emitPrefix}'`,
      );
    }
  });

  // ── jobs ───────────────────────────────────────────────────────────────
  const queuePrefix = pluginQueuePrefix(manifest.slug);

  manifest.jobs.queues.forEach((queue, index) => {
    if (!queue.startsWith(queuePrefix) || queue.length === queuePrefix.length) {
      push(
        ManifestErrorCode.QUEUE_NAMESPACE,
        `jobs.queues[${index}]`,
        `Queue names must be namespaced under '${queuePrefix}'`,
      );
    }
  });

  eachDuplicate(manifest.jobs.queues, (queue, index) => {
    push(ManifestErrorCode.QUEUE_DUPLICATE, `jobs.queues[${index}]`, `'${queue}' listed more than once`);
  });

  manifest.jobs.schedules.forEach((schedule, index) => {
    if (!IDENTIFIER_PATTERN.test(schedule.name)) {
      push(
        ManifestErrorCode.SCHEDULE_NAME_INVALID,
        `jobs.schedules[${index}].name`,
        `'${schedule.name}' must be kebab-case`,
      );
    }

    const fields = schedule.cron.trim().split(/\s+/);

    if (fields.length < 5 || fields.length > 6 || !fields.every((field) => CRON_FIELD_PATTERN.test(field))) {
      push(
        ManifestErrorCode.CRON_INVALID,
        `jobs.schedules[${index}].cron`,
        `'${schedule.cron}' is not a 5–6 field cron expression (full parse happens at schedule registration)`,
      );
    }
  });

  eachDuplicate(
    manifest.jobs.schedules.map((schedule) => schedule.name),
    (name, index) => {
      push(
        ManifestErrorCode.SCHEDULE_NAME_DUPLICATE,
        `jobs.schedules[${index}].name`,
        `Schedule '${name}' is duplicated`,
      );
    },
  );

  // ── storage (D-H: declaration-only at MVP, but shape-enforced now) ─────
  const tablePrefix = pluginTablePrefix(manifest.slug);

  manifest.storage.ownTables.forEach((table, index) => {
    const suffix = table.startsWith(tablePrefix) ? table.slice(tablePrefix.length) : null;

    if (suffix === null || !OWN_TABLE_SUFFIX_PATTERN.test(suffix)) {
      push(
        ManifestErrorCode.OWN_TABLE_PREFIX,
        `storage.ownTables[${index}]`,
        `'${table}' must be snake_case and prefixed with '${tablePrefix}'`,
      );
    }
  });

  eachDuplicate(manifest.storage.ownTables, (table, index) => {
    push(ManifestErrorCode.OWN_TABLE_DUPLICATE, `storage.ownTables[${index}]`, `'${table}' listed more than once`);
  });

  // ── updateCheck (#84 opt-in polling) ───────────────────────────────────
  if (manifest.updateCheck !== undefined) {
    let parsedUrl: URL | null = null;

    try {
      parsedUrl = new URL(manifest.updateCheck.url);
    } catch {
      parsedUrl = null;
    }

    if (parsedUrl === null || parsedUrl.protocol !== 'https:') {
      push(
        ManifestErrorCode.UPDATE_CHECK_URL_INVALID,
        'updateCheck.url',
        'Update check URL must be a valid https:// URL',
      );
    }
  }

  if (issues.length > 0) {
    throw new PluginManifestValidationError(issues);
  }

  return { manifest, permissionChecks, externalPermissionChecks, warnings };
};
