-- #278: mark an invite that a block or the invitee's preference refused,
-- where refusing it outright would tell the inviter so. The invite is stored
-- and answered like any other; only what delivers invites reads the mark.

-- AlterTable
ALTER TABLE "invites" ADD COLUMN "withheld" BOOLEAN NOT NULL DEFAULT false;
