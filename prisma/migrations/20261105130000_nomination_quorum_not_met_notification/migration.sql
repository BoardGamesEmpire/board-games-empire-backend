-- #798: a nomination resolved short of quorum tells its nominator so, rather
-- than calling it failed.

-- AlterEnum
ALTER TYPE "notification_types" ADD VALUE 'GameNominationQuorumNotMet';
