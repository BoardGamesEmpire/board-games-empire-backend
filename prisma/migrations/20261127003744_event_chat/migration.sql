-- CreateEnum
CREATE TYPE "event_chat_access_levels" AS ENUM ('AllAttendees', 'Responded', 'MaybeOrAttending', 'Attending');

-- AlterEnum
ALTER TYPE "resource_types" ADD VALUE 'EventChatMessage';

-- AlterTable
ALTER TABLE "event_policies" ADD COLUMN     "chat_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "chat_post_access" "event_chat_access_levels" NOT NULL DEFAULT 'AllAttendees',
ADD COLUMN     "chat_read_access" "event_chat_access_levels" NOT NULL DEFAULT 'AllAttendees',
ADD COLUMN     "chat_spectators_may_post" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "event_chat_counters" (
    "event_id" TEXT NOT NULL,
    "last_sequence" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "event_chat_counters_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "event_chat_messages" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "author_id" TEXT,
    "sequence" INTEGER NOT NULL,
    "body" TEXT,
    "reply_to_id" TEXT,
    "occurrence_id" TEXT,
    "occurrence_tagged" BOOLEAN NOT NULL DEFAULT false,
    "occurrence_label" TEXT,
    "occurrence_start_date" TIMESTAMPTZ(3),
    "client_request_id" TEXT,
    "edited_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_chat_reactions" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_chat_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_chat_states" (
    "id" TEXT NOT NULL,
    "attendee_id" TEXT NOT NULL,
    "last_read_sequence" INTEGER NOT NULL DEFAULT 0,
    "host_muted_at" TIMESTAMPTZ(3),
    "host_muted_until" TIMESTAMPTZ(3),
    "self_muted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_chat_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_chat_messages_occurrence_id_idx" ON "event_chat_messages"("occurrence_id");

-- CreateIndex
CREATE INDEX "event_chat_messages_event_id_reply_to_id_idx" ON "event_chat_messages"("event_id", "reply_to_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_chat_messages_event_id_sequence_key" ON "event_chat_messages"("event_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "event_chat_messages_event_id_id_key" ON "event_chat_messages"("event_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "event_chat_message_author_client_request_id_unique" ON "event_chat_messages"("author_id", "client_request_id");

-- CreateIndex
CREATE INDEX "event_chat_reactions_user_id_idx" ON "event_chat_reactions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_chat_reactions_message_id_user_id_emoji_key" ON "event_chat_reactions"("message_id", "user_id", "emoji");

-- CreateIndex
CREATE UNIQUE INDEX "event_chat_states_attendee_id_key" ON "event_chat_states"("attendee_id");

-- AddForeignKey
ALTER TABLE "event_chat_counters" ADD CONSTRAINT "event_chat_counters_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_chat_messages" ADD CONSTRAINT "event_chat_messages_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_chat_messages" ADD CONSTRAINT "event_chat_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_chat_messages" ADD CONSTRAINT "event_chat_messages_event_id_reply_to_id_fkey" FOREIGN KEY ("event_id", "reply_to_id") REFERENCES "event_chat_messages"("event_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "event_chat_messages" ADD CONSTRAINT "event_chat_messages_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "event_occurrences"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_chat_reactions" ADD CONSTRAINT "event_chat_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "event_chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_chat_reactions" ADD CONSTRAINT "event_chat_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_chat_states" ADD CONSTRAINT "event_chat_states_attendee_id_fkey" FOREIGN KEY ("attendee_id") REFERENCES "event_attendees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

