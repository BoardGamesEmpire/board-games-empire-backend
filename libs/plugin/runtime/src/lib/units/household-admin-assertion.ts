import type { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import { PluginUnitAuthorityError, PluginUnitHouseholdNotFoundError } from './unit.errors';

/**
 * The household-admin check every per-household plugin writer runs, and what
 * its refusal means. Once the household is deleted, its own admin gets the
 * 404 the route's liveness guard and the in-transaction lock give; everyone
 * else keeps the 403, whatever state the household is in, so the refusal says
 * nothing about which households exist (#548). One copy, so the unit
 * lifecycle and the consent act cannot disagree about it (#1150).
 */
export async function assertHouseholdAdmin(
  authority: Pick<PluginGrantAuthorityService, 'householdAdminStanding'>,
  actorId: string,
  householdId: string,
): Promise<void> {
  const standing = await authority.householdAdminStanding(actorId, householdId);

  if (standing === 'admin') {
    return;
  }

  if (standing === 'deleted') {
    throw new PluginUnitHouseholdNotFoundError(householdId);
  }

  throw new PluginUnitAuthorityError(actorId);
}
