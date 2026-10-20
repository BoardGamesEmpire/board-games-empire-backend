import { SystemRole, type Prisma } from '../client';

/**
 * The roles that make a user one of the server admins: Owner and Admin
 * (GLOSSARY.md). Shared so the plugin grant check and the notifications sent
 * to the server admins agree on who they are (#763).
 */
export const SERVER_ADMIN_ROLE_WHERE = {
  name: { in: [SystemRole.Owner, SystemRole.Admin] },
} satisfies Prisma.RoleWhereInput;
