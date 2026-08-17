import { PluginExecutionMode, PluginScope } from '@bge/database';
import type { PluginExecutionModeValue, PluginScopeValue } from '@boardgamesempire/plugin-manifest';

/**
 * Manifest scope / executionMode values (the framework-free
 * `@boardgamesempire/plugin-manifest` source of truth) → generated Prisma
 * enums. Same convention as `MANIFEST_CATEGORY_TO_PRISMA`
 * (registry/plugin-category.map.ts): each map is the ONE bridge between the
 * two vocabularies, and the bijection spec asserts totality and injectivity
 * in both directions so a value added to one side without the other fails
 * CI rather than drifting silently. First consumer: the install pipeline
 * (#59 C2), which persists manifest values onto the `Plugin` row.
 */
export const MANIFEST_SCOPE_TO_PRISMA: Readonly<Record<PluginScopeValue, PluginScope>> = {
  server: PluginScope.Server,
  household: PluginScope.Household,
};

export const MANIFEST_EXECUTION_MODE_TO_PRISMA: Readonly<Record<PluginExecutionModeValue, PluginExecutionMode>> = {
  'in-process': PluginExecutionMode.InProcess,
  worker: PluginExecutionMode.Worker,
};

/**
 * The mode a plugin gets when its manifest declares none — `executionMode`
 * is an optional author hint, not a required field.
 *
 * MUST mirror `@default(InProcess)` on `Plugin.executionMode`. A fresh
 * install omits the column and lets the database answer; a REINSTALL writes
 * over a tombstoned row, and an update applies no column defaults, so that
 * path has to name the value. Naming it once, here beside the bridge maps,
 * keeps the two answers from drifting the day the schema default changes.
 */
export const DEFAULT_PLUGIN_EXECUTION_MODE: PluginExecutionMode = PluginExecutionMode.InProcess;
