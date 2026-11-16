-- #769: the attendees still coming are told when a game leaves an event's
-- lineup. Postgres can add an enum value inside the migration's transaction,
-- but can't use it there, and nothing here does.

-- AlterEnum
ALTER TYPE "notification_types" ADD VALUE 'GameRemovedFromEvent';
