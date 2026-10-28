import { Action, ResourceType } from '@bge/database';
import type { AppAbility } from '@bge/permissions';

/**
 * The column only the server's own plugin reads serve. Their gate asks about
 * it, and the server list builds its ceiling from the rules that read it.
 */
export const SERVER_PLUGIN_COLUMN = 'installedAt';

/**
 * The gate on the server's own plugin reads: the server list, the detail
 * read, the server consent surface, the staged update and the server feature
 * state. They serve provenance, install history and consent topology.
 *
 * A bare `can(read, Plugin)` would not keep users out. A type check passes on
 * any rule whatever its conditions, and every user holds
 * `read:plugin:installed`, the ceiling the unit lists compose against. That
 * grant is limited to the identity columns, so asking about a column it leaves
 * out is what tells it apart. `installedAt` is one: only the server reads
 * serve it. `read:plugin` and staff's wildcard carry no field list and pass,
 * and so does an API key's `read:plugin` pinned to one plugin's id.
 *
 * An API key's rule keeps its grant's field list, and PoliciesGuard asks the
 * key and its owner both. So a key passes only on a slug that reads every
 * column, and only when its owner passes too: a key holding
 * `read:plugin:installed` is refused whoever owns it.
 *
 * The check is type-level, so a key whose `read:plugin` is pinned to one
 * plugin passes it on every slug. The routes that address one plugin then
 * resolve their slug under the actor's ceiling, and answer a slug outside
 * it as not installed (#789).
 */
export const canReadServerPlugins = (ability: AppAbility): boolean =>
  ability.can(Action.read, ResourceType.Plugin, SERVER_PLUGIN_COLUMN);
