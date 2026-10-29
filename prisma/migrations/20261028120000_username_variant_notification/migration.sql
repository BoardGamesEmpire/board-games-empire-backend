-- #912: a first sign-in through a sign-in provider whose username is taken gets
-- the first free variant, and its user is told. Postgres can add an enum value
-- inside the migration's transaction, but can't use it there, and nothing here
-- does.

-- AlterEnum
ALTER TYPE "notification_types" ADD VALUE 'UsernameVariantAssigned';
