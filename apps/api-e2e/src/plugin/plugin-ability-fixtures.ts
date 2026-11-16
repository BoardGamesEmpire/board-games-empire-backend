import {
  PluginGrantScope,
  type DatabaseService,
  type PluginActiveManifestReader,
  type PluginConfigVerdict,
  type PrismaClient,
} from '@bge/database';
import { PermissionsService } from '@bge/permissions';
import {
  PluginManifestValidationError,
  validatePluginManifest,
  type PluginConsentScopeValue,
} from '@boardgamesempire/plugin-manifest';
import addFormats from 'ajv-formats';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';

/**
 * The consent scope a manifest names, as the decision scope a grant row
 * carries. The runtime's own map lives in `@bge/plugin`, which this project
 * does not depend on; the three entries are the whole of it.
 */
const GRANT_SCOPE: Readonly<Record<PluginConsentScopeValue, PluginGrantScope>> = {
  server: PluginGrantScope.Server,
  household: PluginGrantScope.Household,
  user: PluginGrantScope.User,
};

/**
 * A document judged against a manifest's `config.schema` the way the
 * runtime's `activeManifestOf` judges it (#1151). Restated here because this
 * project does not depend on `@bge/plugin`: the same ajv build and options,
 * `ajv-formats` registered, an asynchronous schema refused, and the schema's
 * usability settled before the document's shape, so an unusable schema
 * answers `'schema-unusable'` whatever the document is, and a document the
 * validator throws on answers `'rejected'`.
 */
function judgeConfig(schema: Record<string, unknown>, document: unknown): PluginConfigVerdict {
  let validate: ValidateFunction;

  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    validate = ajv.compile(schema);
  } catch {
    return 'schema-unusable';
  }

  if ((validate as { $async?: unknown }).$async === true) {
    return 'schema-unusable';
  }

  // A household's document is a plain object or nothing the schema accepts.
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return 'rejected';
  }

  try {
    return validate(document) ? 'conforms' : 'rejected';
  } catch {
    return 'rejected';
  }
}

/**
 * The runtime's active-manifest reader, as a spec can build it: the stored
 * manifest validated again, each requested permission at its decision scope
 * (#577), and what the dormancy rule needs from it (#1151). Without a reader
 * the snapshot confers nothing at all, so a spec asserting that a decision
 * does NOT confer would pass for the wrong reason; each spec using it
 * therefore also asserts a decision that does. Unlike the runtime's reader,
 * it skips the check that the manifest's slug and version agree with the
 * plugin row.
 */
const activeManifestReader: PluginActiveManifestReader = {
  read(row) {
    try {
      const validated = validatePluginManifest(row.manifestJson, {
        bgeVersion: '0.0.0',
        defaultLocale: 'en',
        enforceBgeCompat: false,
      });
      const { manifest } = validated;

      return {
        valid: true,
        manifest: {
          requested: validated.permissionChecks.map((check) => ({
            slug: check.canonicalSlug,
            scopeType: GRANT_SCOPE[check.consentScope],
          })),
          householdSurface: manifest.scope !== 'server',
          judgeConfig: (document) => judgeConfig(manifest.config.schema, document),
        },
      };
    } catch (error) {
      // Only a failed validation is an answer, as in the runtime's reader;
      // anything else is a broken fixture and fails the test loudly.
      if (error instanceof PluginManifestValidationError) {
        return { valid: false, detail: error.message };
      }

      throw error;
    }
  },
};

/**
 * The core permissions a plugin's ability holds for one household, as
 * `PermissionsService.getPluginGrantSnapshot` resolves them from the rows
 * (#1150). The snapshot read touches neither cache, so the service runs here
 * over the spec's own client.
 */
export async function pluginAbilitySlugsForHousehold(
  client: PrismaClient,
  pluginId: string,
  householdId: string,
): Promise<string[]> {
  const service = new PermissionsService(
    client as unknown as DatabaseService,
    {} as never,
    {} as never,
    activeManifestReader,
  );
  const snapshot = await service.getPluginGrantSnapshot(pluginId, { scopeType: 'Household', householdId });

  return (snapshot?.corePermissions ?? []).map((permission) => permission.slug).sort();
}
