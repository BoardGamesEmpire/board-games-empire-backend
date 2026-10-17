-- #713: the server stores portable and arcade platform types as DataGateways
-- send them, rather than folding portable into console and arcade into other,
-- so a search can be filtered by either. A platform stored before this keeps
-- its folded type, since an import never changes a stored platform's type;
-- nothing is deployed, so no such platform is in use. Each value goes where
-- the schema lists it, so ordering by platform type follows the schema.

-- AlterEnum
ALTER TYPE "platform_types" ADD VALUE 'Portable' AFTER 'Console';
ALTER TYPE "platform_types" ADD VALUE 'Arcade' AFTER 'Mobile';
