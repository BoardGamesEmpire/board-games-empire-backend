import type { Prisma, Upstream, UpstreamAccount } from '@bge/database';
import {
  constraintIdentity,
  DatabaseService,
  identifiesConstraint,
  isPrismaDependentRecordNotFoundError,
  isPrismaUniqueConstraintError,
} from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { PRIVACY_POLICY_PATH, PrivacyPolicyService } from '@bge/system-settings';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Http } from '@status/codes';
import type { UpstreamPrivacyPolicyDto } from './dto/upstream-accounts-response.dto';
import { UpstreamAccountErrorCode, UPSTREAMS_WITH_LINK_METHOD } from './upstream-account.constants';
import type { UpstreamAccountSnapshot } from './upstream-account.events';
import {
  UpstreamAccountLinkedEvent,
  upstreamAccountSnapshot,
  UpstreamAccountUnlinkedEvent,
} from './upstream-account.events';

/** What linking an upstream account stores. */
export interface CreateUpstreamAccountInput {
  displayName?: string | null;
  externalId: string;
  profileUrl?: string | null;
  upstream: Upstream;
  userId: string;

  /** Whether the upstream itself vouched for the account, as Steam sign-in does. */
  verified: boolean;
}

/** The columns an unlink returns: its event's snapshot, every column but `createdAt`. */
const SNAPSHOT_SELECT = {
  id: true,
  userId: true,
  upstream: true,
  externalId: true,
  displayName: true,
  profileUrl: true,
  verified: true,
  updatedAt: true,
} as const satisfies Prisma.UpstreamAccountSelect;

/**
 * The unique that holds a user to one account per upstream, in every spelling
 * a P2002 identity reports it (see `identifiesConstraint`): the index name
 * Prisma gave it, the raw columns, and the Prisma fields.
 */
const USER_UPSTREAM_SPELLINGS = [
  ['upstream_accounts_user_id_upstream_key'],
  ['user_id', 'upstream'],
  ['userId', 'upstream'],
] as const;

/**
 * The partial unique index that holds a verified external id to one user, in
 * every spelling a P2002 identity reports it. The migration writes it by hand,
 * so its name is the migration's.
 */
const VERIFIED_EXTERNAL_ID_SPELLINGS = [
  ['upstream_accounts_verified_external_id'],
  ['upstream', 'external_id'],
  ['upstream', 'externalId'],
] as const;

/**
 * A user's upstream accounts (#935): which upstreams can be linked, the
 * user's own accounts, unlinking one, and storing one a link has proved. Each
 * link and unlink is audited through its event.
 */
@Injectable()
export class UpstreamAccountService {
  private readonly logger = new Logger(UpstreamAccountService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly eventEmitter: EventEmitter2,
    private readonly privacyPolicyService: PrivacyPolicyService,
  ) {}

  /**
   * The upstreams a user can link an account at now: those this server has a
   * way to link ({@link UPSTREAMS_WITH_LINK_METHOD}) that an enabled,
   * undeleted DataGateway declares. Ordered as the `Upstream` enum is.
   */
  async linkableUpstreams(): Promise<Upstream[]> {
    const declared = await this.db.dataGateway.findMany({
      where: { enabled: true, deletedAt: null, upstream: { not: null } },
      select: { upstream: true },
      distinct: ['upstream'],
      orderBy: { upstream: 'asc' },
    });

    return declared
      .map(({ upstream }) => upstream)
      .filter((upstream): upstream is Upstream => upstream !== null && UPSTREAMS_WITH_LINK_METHOD.has(upstream));
  }

  /**
   * The user's upstream accounts within `scope`, the read the controller
   * composed, ordered by upstream. An account stays listed when no DataGateway
   * declares its upstream any more.
   */
  async list(userId: string, scope: Prisma.UpstreamAccountWhereInput): Promise<UpstreamAccount[]> {
    return this.db.upstreamAccount.findMany({
      where: { AND: [scope, { userId }] },
      orderBy: { upstream: 'asc' },
    });
  }

  /**
   * Unlinks the user's account at `upstream`, within `scope`, the delete the
   * controller composed. Its sync logs are deleted with it; the games already
   * in the user's collection stay. No such account within the scope answers
   * 404 `UPSTREAM_ACCOUNT_NOT_FOUND`.
   *
   * The account is found by user and upstream, then deleted by its id, each
   * with the scope in its top-level `where`. A compound unique key can't sit
   * there: for a caller with no rule, the database service's CASL extension
   * copies the whole `where` into an `AND`, where Prisma refuses that key. The
   * delete returns the row, so the event names the row deleted; an unlink that
   * deletes it first answers the same 404.
   */
  async unlink(userId: string, upstream: Upstream, scope: Prisma.UpstreamAccountWhereInput): Promise<void> {
    const initiatedAt = new Date();
    const notFound = () =>
      new CodedHttpException(
        Http.NotFound,
        UpstreamAccountErrorCode.NotFound,
        t('errors.upstream_account.not_found', { upstream }),
      );

    const found = await this.db.upstreamAccount.findFirst({
      where: { AND: [scope, { userId, upstream }] },
      select: { id: true },
    });
    if (!found) {
      throw notFound();
    }

    let removed: UpstreamAccountSnapshot;
    try {
      removed = await this.db.upstreamAccount.delete({
        where: { id: found.id, AND: [scope] },
        select: SNAPSHOT_SELECT,
      });
    } catch (error) {
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw notFound();
      }

      throw error;
    }

    this.eventEmitter.emit(
      UpstreamAccountUnlinkedEvent.eventName,
      new UpstreamAccountUnlinkedEvent(removed, initiatedAt),
    );
  }

  /**
   * Stores an upstream account a link has proved, or a user has claimed.
   *
   * The database decides the two refusals, so two links at once can't both
   * pass a check made first: a user who already has an account at the
   * upstream gets 409 `UPSTREAM_ACCOUNT_ALREADY_LINKED`, and a verified
   * external id another user holds gets 409 `UPSTREAM_ACCOUNT_TAKEN`, whose
   * message names no one.
   */
  async create(input: CreateUpstreamAccountInput): Promise<UpstreamAccount> {
    const initiatedAt = new Date();

    let account: UpstreamAccount;
    try {
      account = await this.db.upstreamAccount.create({
        data: {
          userId: input.userId,
          upstream: input.upstream,
          externalId: input.externalId,
          displayName: input.displayName ?? null,
          profileUrl: input.profileUrl ?? null,
          verified: input.verified,
        },
      });
    } catch (error) {
      throw await this.createFailure(error, input);
    }

    this.eventEmitter.emit(
      UpstreamAccountLinkedEvent.eventName,
      new UpstreamAccountLinkedEvent(upstreamAccountSnapshot(account), initiatedAt),
    );

    return account;
  }

  /**
   * Refuses with 409 `UPSTREAM_ACCOUNT_ALREADY_LINKED`, the answer `create`
   * would give, when the user already has an account at `upstream`: a link
   * that starts by sending the user to the upstream checks first, so they
   * aren't sent there for nothing (#935). `create` still decides, since an
   * account can be linked in between.
   */
  async assertNotLinked(userId: string, upstream: Upstream): Promise<void> {
    if (await this.hasAccountAt(userId, upstream)) {
      throw this.alreadyLinked(upstream);
    }
  }

  /**
   * The privacy policy a user is shown before linking an upstream account
   * (#934): the language and date of the policy `GET /api/privacy-policy`
   * would serve them, chosen as that route chooses it, by their stored
   * language and then `acceptLanguage`.
   */
  async privacyPolicy(userId: string, acceptLanguage: string | undefined): Promise<UpstreamPrivacyPolicyDto> {
    const policy = await this.privacyPolicyService.readFor({ userId, acceptLanguage });

    return { url: PRIVACY_POLICY_PATH, language: policy.language, updatedAt: policy.updatedAt };
  }

  /**
   * A create's failure, as the client should hear it. A unique violation
   * names one of the two uniques; one whose constraint can't be named (the
   * pg adapter on Prisma 7.10 reports no `meta.target`, prisma/prisma#28953)
   * is settled by reading whether the user now has an account at the
   * upstream. The create runs outside a transaction, so the read sees the row
   * that beat it.
   */
  private async createFailure(error: unknown, input: CreateUpstreamAccountInput): Promise<unknown> {
    if (!isPrismaUniqueConstraintError(error)) {
      return error;
    }

    const identity = constraintIdentity(error);
    if (identifiesConstraint(identity, ...USER_UPSTREAM_SPELLINGS)) {
      return this.alreadyLinked(input.upstream);
    }

    if (identifiesConstraint(identity, ...VERIFIED_EXTERNAL_ID_SPELLINGS)) {
      return this.taken(input.upstream);
    }

    if (identity.source === 'unknown') {
      return (await this.hasAccountAt(input.userId, input.upstream))
        ? this.alreadyLinked(input.upstream)
        : this.taken(input.upstream);
    }

    // By the constraint, the error's name and its code only: a Prisma error's
    // message and stack print the call's arguments, the account's external id
    // among them, which unlinking deletes.
    this.logger.error(
      `Upstream account insert hit an unexpected unique: ${JSON.stringify(identity)} (${error.name} ${error.code})`,
    );
    return error;
  }

  /** Whether the user has an account at `upstream`, read outside any transaction. */
  private async hasAccountAt(userId: string, upstream: Upstream): Promise<boolean> {
    const existing = await this.db.upstreamAccount.findUnique({
      where: { userId_upstream: { userId, upstream } },
      select: { id: true },
    });

    return existing !== null;
  }

  private alreadyLinked(upstream: Upstream): CodedHttpException {
    return new CodedHttpException(
      Http.Conflict,
      UpstreamAccountErrorCode.AlreadyLinked,
      t('errors.upstream_account.already_linked', { upstream }),
    );
  }

  private taken(upstream: Upstream): CodedHttpException {
    return new CodedHttpException(
      Http.Conflict,
      UpstreamAccountErrorCode.Taken,
      t('errors.upstream_account.taken', { upstream }),
    );
  }
}
