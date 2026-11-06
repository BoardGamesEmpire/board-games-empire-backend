-- #913: whether a sign-in provider's sign-in can link itself to the registered user with the same email.
CREATE TYPE "provider_linking_policy_types" AS ENUM ('SignedIn', 'AutomaticWhenVerified');

ALTER TABLE "system_settings" ADD COLUMN "provider_linking_policy" "provider_linking_policy_types" NOT NULL DEFAULT 'SignedIn';
