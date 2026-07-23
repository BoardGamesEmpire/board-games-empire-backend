import { z } from 'zod';
import {
  CORE_MODEL_NAME_PATTERN,
  EVENT_SUBSCRIBE_PATTERN,
  IDENTIFIER_PATTERN,
  PLUGIN_CATEGORIES,
  PLUGIN_CONSENT_SCOPES,
  PLUGIN_EXECUTION_MODES,
  PLUGIN_SCOPES,
  PLUGIN_SLUG_PATTERN,
  TOPIC_NAME_PATTERN,
} from './constants.js';
import { localizedStringSchema } from './localized-string.js';

/**
 * STRUCTURAL manifest schema (issue #59 "Manifest type & JSON schema").
 *
 * Deliberately contains no `.refine()` / `.superRefine()` / `.transform()`:
 * zod refinements do not serialize into the generated JSON Schema, so any
 * rule expressed as a refinement would silently vanish from the artifact
 * published for plugin authors and `bge-plugin validate` (#84). Everything
 * JSON Schema can express (shapes, enums, patterns, bounds, strictness)
 * lives here; every cross-field or configuration-dependent rule lives in
 * the semantic pass (`manifest-validator.ts`) with a typed rejection code.
 */

export const pluginFeatureDeclarationSchema = z.strictObject({
  name: z.string().regex(IDENTIFIER_PATTERN),
  displayName: localizedStringSchema,
  description: localizedStringSchema,
});

export const pluginPermissionRequestSchema = z.strictObject({
  slug: z.string().min(3),
  required: z.boolean(),
  reason: localizedStringSchema,
  feature: z.string().regex(IDENTIFIER_PATTERN).optional(),
  /** Who must consent to grant it; defaulting to 'server' happens in the semantic pass output. */
  consentScope: z.enum(PLUGIN_CONSENT_SCOPES).optional(),
});

export const pluginTopicDeclarationSchema = z.strictObject({
  name: z.string().regex(TOPIC_NAME_PATTERN),
  displayName: localizedStringSchema,
  description: localizedStringSchema,
  scope: z.enum(PLUGIN_CONSENT_SCOPES),
  payloadSchemaVersion: z.number().int().min(1),
});

export const pluginUpdateCheckSchema = z.strictObject({
  url: z.string().min(1),
  /** Clamped minimum 1h, default 24h — clamping is consumer behavior (#84), the floor is structural. */
  pollIntervalHours: z.number().int().min(1).optional(),
});

export const pluginScheduleSchema = z.strictObject({
  name: z.string().min(1),
  cron: z.string().min(9),
});

export const pluginManifestSchema = z.strictObject({
  slug: z.string().regex(PLUGIN_SLUG_PATTERN),
  version: z.string().min(5),
  /** Semver RANGE — validity of the range and satisfaction against the running BGE version are semantic. */
  bgeCompat: z.string().min(1),
  category: z.enum(PLUGIN_CATEGORIES),
  scope: z.enum(PLUGIN_SCOPES),
  /** Isolation tier hint, admin-overridable (#197). */
  executionMode: z.enum(PLUGIN_EXECUTION_MODES).optional(),
  displayName: localizedStringSchema,
  description: localizedStringSchema,
  features: z.array(pluginFeatureDeclarationSchema),
  permissions: z.strictObject({
    declares: z.array(z.string().min(3)),
    checks: z.array(pluginPermissionRequestSchema),
  }),
  events: z.strictObject({
    subscribes: z.array(z.string().regex(EVENT_SUBSCRIBE_PATTERN)),
    emits: z.array(z.string().min(1)),
  }),
  topics: z.array(pluginTopicDeclarationSchema),
  network: z.strictObject({
    outboundDomains: z.union([z.array(z.string().min(1)), z.literal('configured')]),
  }),
  storage: z.strictObject({
    ownTables: z.array(z.string().min(1)),
    readsCore: z.array(z.string().regex(CORE_MODEL_NAME_PATTERN)),
    writesCore: z.array(z.string().regex(CORE_MODEL_NAME_PATTERN)),
  }),
  jobs: z.strictObject({
    queues: z.array(z.string().min(1)),
    schedules: z.array(pluginScheduleSchema),
  }),
  config: z.strictObject({
    /** JSON Schema document for the plugin's own config surface; validated as an object, not interpreted here. */
    schema: z.record(z.string(), z.unknown()),
    requiresHouseholdConfig: z.boolean(),
  }),
  metadataSchemaVersion: z.number().int().min(1),
  updateCheck: pluginUpdateCheckSchema.optional(),
});
