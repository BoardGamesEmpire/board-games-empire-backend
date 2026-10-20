import { DatabaseService, SERVER_ADMIN_ROLE_WHERE } from '@bge/database';

/** The ids of the server admins: the users holding the Owner or Admin server role (#763). */
export async function findServerAdminIds(db: DatabaseService): Promise<string[]> {
  const admins = await db.user.findMany({
    where: { roles: { some: { role: SERVER_ADMIN_ROLE_WHERE } } },
    select: { id: true },
  });

  return admins.map((admin) => admin.id);
}
