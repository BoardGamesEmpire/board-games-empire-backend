import { PluginCategory } from '@bge/database';
import type { RoutedPlugin } from './plugin-driver-source';
import { isPluginServed, PLUGIN_SERVED_WHERE } from './served-plugin';

/** A plugin the server serves: a data-gateway plugin, switched on, installed, and loaded without a failure. */
const servedPlugin = (overrides: Partial<RoutedPlugin> = {}): RoutedPlugin => ({
  id: 'plugin-1',
  slug: 'acme-games',
  category: PluginCategory.DataGateway,
  enabled: true,
  uninstalledAt: null,
  loadFailed: false,
  installedAt: new Date('2026-11-01T00:00:00Z'),
  ...overrides,
});

interface Row {
  plugin: RoutedPlugin | null;
  pluginId: string | null;
}

const isOperator = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

/**
 * Whether `where` matches `value`, read as Prisma reads it, for the forms the
 * filter uses: `OR`, a to-one relation's `is`, and a field equal to a value
 * or to null. Any other form throws, so a change to the filter can't pass
 * here by being misread.
 */
function matches(value: unknown, where: unknown): boolean {
  if (!isOperator(where)) {
    return value === where;
  }

  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') {
      if (!Array.isArray(condition)) {
        throw new TypeError('OR takes an array');
      }

      return condition.some((arm) => matches(value, arm));
    }

    if (key === 'is') {
      return value !== null && matches(value, condition);
    }

    if (isOperator(condition) && !('is' in condition)) {
      throw new Error(`The spec's reading of a Prisma filter doesn't support '${key}: ${JSON.stringify(condition)}'`);
    }

    if (!isOperator(value)) {
      throw new TypeError(`'${key}' is read off something that isn't a row`);
    }

    return matches(value[key], condition);
  });
}

// A link at an upstream picks a DataGateway with a database filter, while
// routing reads the row and asks `isPluginServed`. Both must refuse the same
// plugin DataGateways, or a link would pick one routing then refuses (#1226).
describe('the plugin-served rule, as a database filter and on a row read (#1083, #1226)', () => {
  it.each([
    ['served', servedPlugin(), true],
    ['moved out of the data-gateway category', servedPlugin({ category: PluginCategory.EventHook }), false],
    ['switched off', servedPlugin({ enabled: false }), false],
    ['uninstalled', servedPlugin({ uninstalledAt: new Date('2026-11-02T00:00:00Z') }), false],
    ['quarantined by a failed load', servedPlugin({ loadFailed: true }), false],
  ])('agree on a plugin DataGateway whose plugin is %s', (_name, plugin, served) => {
    expect(isPluginServed(plugin)).toBe(served);
    expect(matches({ pluginId: plugin.id, plugin } satisfies Row, PLUGIN_SERVED_WHERE)).toBe(served);
  });

  it('lets a remote DataGateway through the filter: it has no plugin to serve it', () => {
    expect(matches({ pluginId: null, plugin: null } satisfies Row, PLUGIN_SERVED_WHERE)).toBe(true);
  });
});
