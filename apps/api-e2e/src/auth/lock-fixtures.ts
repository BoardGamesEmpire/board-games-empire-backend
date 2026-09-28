import { SystemRole } from '@bge/database';
import type { BarrierConnection } from '../support/lock-barrier';

/**
 * Holds every signup's provisioning at its `user_roles` insert, for as long
 * as `holder`'s transaction stays open.
 *
 * Provisioning writes the new user's roles in one transaction, and that
 * insert's foreign key takes `FOR KEY SHARE` on the `User` role row, which
 * this `FOR UPDATE` blocks. So a provisioning transaction gets as far as it
 * can and stops before its roles are written: its election, when it holds
 * one, is already decided, and the user holds no role yet. Committing the
 * holder lets every held transaction go on.
 *
 * Commit promptly. A held provisioning transaction runs under Prisma's default
 * five-second interactive-transaction timeout, and the wait counts against it:
 * one held past that rolls back, and the spec then times out waiting for roles
 * that were never going to be written.
 */
export async function holdProvisioningAtRoleWrite(holder: BarrierConnection): Promise<void> {
  await holder.begin();
  await holder.query('SELECT id FROM roles WHERE name = $1 FOR UPDATE', [SystemRole.User]);
}
