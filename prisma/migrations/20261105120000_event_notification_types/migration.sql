-- #802: a user whose RSVP someone else changed, the attendees of a deleted
-- event and a removed attendee are told. Postgres can add an enum value inside
-- the migration's transaction, but can't use it there, and nothing here does.

-- AlterEnum
ALTER TYPE "notification_types" ADD VALUE 'EventRsvpChanged';
ALTER TYPE "notification_types" ADD VALUE 'EventDeleted';
ALTER TYPE "notification_types" ADD VALUE 'EventAttendeeRemoved';
