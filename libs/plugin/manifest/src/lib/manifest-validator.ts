import { satisfies, valid, validRange } from 'semver';
import {
  CRON_FIELD_PATTERN,
  DEFAULT_MIN_REASON_LENGTH,
  EVENT_NAME_PATTERN,
  IDENTIFIER_PATTERN,
  LOW_EFFORT_REASON_PATTERN,
  OWN_TABLE_SUFFIX_PATTERN,
  pluginEmitPrefix,
  pluginQueuePrefix,
  pluginTablePrefix,
  RESERVED_PLUGIN_SLUGS,
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
import type {
  DeclaredPluginPermission,
  NormalizedPermissionRequest,
  PluginManifest,
  PluginManifestValidationResult,
} from './manifest.types.js';
import { expandPluginPermissionSlug, PLUGIN_PERMISSION_DELIMITER } from './plugin-permission-slug.js';

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

  /**
   * When false, the bgeCompat SATISFACTION check is skipped (the range's
   * shape is still validated). Consent-time re-validation uses this
   * (`PluginGrantService`): whether the plugin can LOAD under the current
   * BGE is irrelevant to recording a decision about it, and a BGE upgrade
   * past a plugin's declared range must not make its grants undecidable —
   * not even a denial could be recorded otherwise. Default true.
   */
  readonly enforceBgeCompat?: boolean;
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
// only gates the SHAPE. Check routing runs first: a check slug present in
// `declares` (bare form) is an OWN check and never reaches this pattern.
const CORE_PERMISSION_SLUG_PATTERN = /^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)+$/;

// The retired Phase A convention had authors hand-write `plugin:<slug>:`
// prefixes; a manifest still carrying that shape gets a migration-guidance
// rejection rather than a silent misroute into the core partition (which
// `plugin:demo:x` would otherwise pattern-match).
const LEGACY_PLUGIN_NAMESPACE_PATTERN = /^plugin:/;

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
 * steps 2–9 plus the Phase A audit rules (D-J scope coherence, D-K slug
 * reservation). Collect-all by design — every issue in one throw.
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

  if (valid(options.bgeVersion) === null) {
    throw new RangeError(
      `ManifestValidationOptions.bgeVersion '${options.bgeVersion}' is not a valid semver version — server/build misconfiguration, not a manifest issue`,
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

  // ── version / bgeCompat ────────────────────────────────────────────
  if (valid(manifest.version) === null) {
    push(ManifestErrorCode.VERSION_INVALID, 'version', `'${manifest.version}' is not a valid semver version`);
  }

  if (validRange(manifest.bgeCompat) === null) {
    push(
      ManifestErrorCode.BGE_COMPAT_INVALID_RANGE,
      'bgeCompat',
      `'${manifest.bgeCompat}' is not a valid semver range`,
    );
  } else if (
    (options.enforceBgeCompat ?? true) &&
    !satisfies(options.bgeVersion, manifest.bgeCompat, { includePrerelease: true })
  ) {
    push(
      ManifestErrorCode.BGE_COMPAT_UNSATISFIED,
      'bgeCompat',
      `BGE ${options.bgeVersion} does not satisfy required range '${manifest.bgeCompat}'`,
    );
  }

  // ── slug reservation ─────────────────────────────────
  if (RESERVED_PLUGIN_SLUGS.has(manifest.slug)) {
    push(
      ManifestErrorCode.SLUG_RESERVED,
      'slug',
      `'${manifest.slug}' is reserved: 'plugin.${manifest.slug}.*' emit namespaces would be ambiguous against the 'plugin.*' lifecycle routing keys for wildcard listeners`,
    );
  }

  // ── scope coherence (D-J) ──────────────────────────────────
  // Per-check consentScope coherence lives in the checks loop below. Topics
  // are deliberately EXEMPT: topic subscription is a per-user opt-in at the
  // topic runtime (#196), never a PluginGrant, so a household/user-scoped
  // topic on a server-scope plugin has no missing consent surface.
  if (manifest.scope === 'server' && manifest.config.requiresHouseholdConfig) {
    push(
      ManifestErrorCode.SCOPE_INCOHERENT,
      'config.requiresHouseholdConfig',
      'A server-scope plugin has no HouseholdPlugin enable/config surface to collect household configuration',
    );
  }

  const canonicalDefaultLocale = canonicalizeLocale(options.defaultLocale);
  // ── localization (issue "Localization rules") ─────────────────────────
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

  // ── permissions.declares (#59 step 3) ───────────────────────────────
  // Bare-slug shape is STRUCTURAL (zod pattern → published JSON Schema);
  // only duplication remains semantic. Expansion to the canonical
  // `plugin|<slug>|<bare>` envelope happens here, in the one shared helper.
  eachDuplicate(manifest.permissions.declares, (slug, index) => {
    push(
      ManifestErrorCode.PERMISSION_DECLARE_DUPLICATE,
      `permissions.declares[${index}]`,
      `'${slug}' declared more than once`,
    );
  });

  const declaredPermissions: DeclaredPluginPermission[] = manifest.permissions.declares.map((bareSlug) => ({
    bareSlug,
    canonicalSlug: expandPluginPermissionSlug(manifest.slug, bareSlug),
  }));

  // ── permissions.checks ──────────────────────────────────────────
  const declared = new Set(manifest.permissions.declares);
  const featureNames = new Set(manifest.features.map((feature) => feature.name));
  const externalPermissionChecks: string[] = [];
  const permissionChecks: NormalizedPermissionRequest[] = [];

  manifest.permissions.checks.forEach((check, index) => {
    const path = `permissions.checks[${index}]`;
    const consentScope = check.consentScope ?? 'server';

    // Check routing: membership in `declares` is authoritative — a declared
    // bare slug SHADOWS an identically named core slug for this manifest
    // (the plugin controls its own catalog; needing both means renaming the
    // declared one). A bare-shaped check absent from `declares` routes to
    // the core partition; if the author simply forgot to declare it, the
    // install-time existence check (C2) fails loudly with a
    // did-you-mean-to-declare hint.
    if (declared.has(check.slug)) {
      permissionChecks.push({
        ...check,
        consentScope,
        origin: 'plugin',
        canonicalSlug: expandPluginPermissionSlug(manifest.slug, check.slug),
      });
    } else if (check.slug.includes(PLUGIN_PERMISSION_DELIMITER) || LEGACY_PLUGIN_NAMESPACE_PATTERN.test(check.slug)) {
      push(
        ManifestErrorCode.PERMISSION_CHECK_SHAPE,
        `${path}.slug`,
        `'${check.slug}' — write bare '<action>:<subject>' slugs; the 'plugin|' envelope is generated at activation and the Phase A 'plugin:' prefix convention is retired. Cross-plugin permission checks are not expressible.`,
      );
    } else if (!CORE_PERMISSION_SLUG_PATTERN.test(check.slug)) {
      push(
        ManifestErrorCode.PERMISSION_CHECK_SHAPE,
        `${path}.slug`,
        `'${check.slug}' is neither a declared bare slug nor shaped like a core permission slug (e.g. 'read:game')`,
      );
    } else {
      externalPermissionChecks.push(check.slug);
      permissionChecks.push({ ...check, consentScope, origin: 'core', canonicalSlug: check.slug });
    }

    // D-J as narrowed by #225: 'household' consent on a server-scope plugin
    // still has no HouseholdPlugin surface to collect it; 'user' consent is
    // permitted at ANY plugin scope, because UserPlugin is the per-user
    // enable surface D-J originally said did not exist.
    if (manifest.scope === 'server' && consentScope === 'household') {
      push(
        ManifestErrorCode.SCOPE_INCOHERENT,
        `${path}.consentScope`,
        `'${check.slug}' requests household-scope consent, but a server-scope plugin has no HouseholdPlugin enable surface to collect it (D-J)`,
      );
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

  // ── features ──────────────────────────────────────────────────────
  eachDuplicate(
    manifest.features.map((feature) => feature.name),
    (name, index) => {
      push(ManifestErrorCode.FEATURE_NAME_DUPLICATE, `features[${index}].name`, `Feature name '${name}' is duplicated`);
    },
  );

  // ── network.outboundDomains (#59 step 6) ──────────────────────────────
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

  // ── topics (#196 manifest surface) ──────────────────────────────────
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

  // ── events ───────────────────────────────────────────────────────
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

  // ── jobs ─────────────────────────────────────────────────────────
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

  // ── updateCheck (#84 opt-in polling) ─────────────────────────────────
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

  return { manifest, permissionChecks, declaredPermissions, externalPermissionChecks, warnings };
};
