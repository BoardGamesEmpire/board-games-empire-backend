import { DatabaseService, User } from '@bge/database';
import { Injectable, Logger } from '@nestjs/common';

/** Reserved identity for the single system service account (login-disabled). */
const SERVICE_ACCOUNT_USERNAME = '__system__';
const SERVICE_ACCOUNT_EMAIL = 'system@bge.local';

@Injectable()
export class ServiceAccountService {
  private readonly logger = new Logger(ServiceAccountService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Idempotently ensures the system service account exists, returning it. Safe
   * to call repeatedly and concurrently — the upsert keys on the reserved unique
   * username, so races collapse to one row. Called when the first Owner is
   * provisioned (system birth); a future onboarding wizard reuses this.
   */
  async ensure(): Promise<User> {
    const reserved = { isServiceAccount: true, banned: true, emailVerified: true };
    const account = await this.db.user.upsert({
      where: { username: SERVICE_ACCOUNT_USERNAME },
      update: reserved, // re-assert invariants on a pre-existing / hand-edited row
      create: { username: SERVICE_ACCOUNT_USERNAME, email: SERVICE_ACCOUNT_EMAIL, ...reserved },
    });

    this.logger.debug(`Service account ensured: ${account.id}`);
    return account;
  }

  /** Resolves the canonical service account by its reserved identity. */
  async resolve(): Promise<User> {
    return this.db.user.findUniqueOrThrow({
      where: {
        isServiceAccount: true,
        username: SERVICE_ACCOUNT_USERNAME,
      },
    });
  }
}
