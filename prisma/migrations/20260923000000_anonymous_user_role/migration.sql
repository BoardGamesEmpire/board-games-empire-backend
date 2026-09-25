-- #484: `AnonymousUser`, the base role an anonymous user (a temporary,
-- account-less guest created by better-auth's anonymous plugin) is provisioned
-- with in place of `User`. No column is typed `system_roles`; the value is
-- added so the database enum keeps matching the schema.

-- AlterEnum
ALTER TYPE "system_roles" ADD VALUE 'AnonymousUser';
