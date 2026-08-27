import type { Prisma } from '@bge/database';
import type { PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import type { PluginConfigSchemaService } from './plugin-config-schema.service';

type ActiveManifest = PluginManifestValidationResult['manifest'];

export interface RetainedServerConfig {
  readonly config: Record<string, unknown>;
  readonly reset: boolean;
}

/**
 * Server config's retained-value rule (D-BJ on #320): carried forward only if
 * it satisfies the schema now taking effect; otherwise reset to `{}`, with
 * the caller recording the reset. Failing the manifest replacement outright
 * was rejected — an admin whose only escape hatch destroys retained config is
 * offered no choice at all. A schema that cannot compile proves nothing about
 * the retained value, so it resets too; the broken schema itself surfaces
 * loudly on the first config write.
 *
 * Shared by both manifest-replacing transactions — reinstall-over-tombstone
 * and activation (D-CN on #59/#370) — so the rule cannot read differently in
 * one than the other.
 */
export function retainedServerConfig(
  configSchema: PluginConfigSchemaService,
  manifest: ActiveManifest,
  retained: Prisma.JsonValue,
): RetainedServerConfig {
  const isPlainObject = typeof retained === 'object' && retained !== null && !Array.isArray(retained);

  if (!isPlainObject) {
    return { config: {}, reset: true };
  }

  const config = retained as Record<string, unknown>;

  try {
    const issues = configSchema.validate({
      slug: manifest.slug,
      version: manifest.version,
      schema: manifest.config.schema,
      config,
    });

    return issues.length === 0 ? { config, reset: false } : { config: {}, reset: true };
  } catch {
    return { config: {}, reset: true };
  }
}
