import { SystemRole, type PrismaClient, type User } from '@bge/database';

/**
 * Dependencies the factories receive by injection from the consuming e2e
 * app (#256 / #254 D-10). The harness support utilities that produce these
 * (`requireBaseUrl`, `createTestDatabase`) live in `apps/api-e2e/src/support`,
 * which a lib cannot import — and duplicating them here would fork the
 * provisioning story #255 just unified. Extraction of those primitives into
 * this lib is deferred until a second consuming app exists (#258).
 */
export interface ActorDeps {
  /**
   * Base URL of the harness-launched API server (no trailing slash needed;
   * one is tolerated). Everything behavioral travels over this URL — the
   * suite is black-box (#255 revised D-6).
   */
  readonly baseUrl: string;

  /**
   * Test-owned Prisma client bound to the ephemeral database. Used for
   * PLUMBING only: waiting out asynchronous provisioning, arranging roster
   * rows, and granting catalog roles — never as a channel into the running
   * server's behavior.
   */
  readonly prisma: PrismaClient;

  /** Injectable for unit tests; defaults to the global `fetch`. */
  readonly fetchFn?: typeof fetch;
}

/** The wire credential a factory-minted actor authenticates with. */
export interface SessionCredentials {
  /** The raw session token (bearer() plugin transport). */
  readonly token: string;

  /** Ready for supertest's `.set(actor.headers)`. */
  readonly headers: { readonly Authorization: string };
}

/**
 * A persisted, authenticated actor: a real `User` row created through the
 * real signup path, with a credential the running server accepts.
 */
export interface SessionActor {
  /** The persisted row, loaded after provisioning completed. */
  readonly user: User;

  readonly credentials: SessionCredentials;

  /** Convenience alias for `credentials.headers`. */
  readonly headers: SessionCredentials['headers'];

  /** The plaintext password used at signup, for re-sign-in scenarios. */
  readonly password: string;
}

/** The household-scoped subset of the seeded role catalog. */
export const HOUSEHOLD_ROLE_NAMES = [
  SystemRole.HouseholdOwner,
  SystemRole.HouseholdAdmin,
  SystemRole.HouseholdMember,
  SystemRole.HouseholdGuest,
] as const;

export type HouseholdRoleName = (typeof HOUSEHOLD_ROLE_NAMES)[number];
