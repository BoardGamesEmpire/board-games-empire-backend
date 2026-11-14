-- How far an event's occurrences may override its restrictions, and an
-- occurrence's explicit "no restriction" values (#796). Existing events take
-- Any, which is what an occurrence's policy could already do.
CREATE TYPE "occurrence_override_scopes" AS ENUM ('None', 'TightenOnly', 'Any');

ALTER TABLE "event_occurrence_policies" ADD COLUMN "capacity_unrestricted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "platform_types_unrestricted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "platforms_unrestricted" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "event_policies" ADD COLUMN "occurrence_override_scope" "occurrence_override_scopes" NOT NULL DEFAULT 'Any';
