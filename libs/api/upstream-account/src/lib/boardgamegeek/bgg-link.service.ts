import { GatewayCoordinatorClientService } from '@bge/coordinator';
import type { UpstreamAccount } from '@bge/database';
import { Upstream } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import type { CoordinatorFindUpstreamAccountResponse, UpstreamAccountData } from '@boardgamesempire/proto-gateway';
import { ResultStatus } from '@boardgamesempire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import { Http } from '@status/codes';
import * as crypto from 'node:crypto';
import { defer, firstValueFrom, timeout } from 'rxjs';
import { httpAddress } from '../http-address';
import { UpstreamAccountErrorCode } from '../upstream-account.constants';
import { UpstreamAccountService } from '../upstream-account.service';
import { UpstreamThrottledException } from '../upstream-throttled.exception';

/**
 * How long a link waits for the DataGateway's answer before it answers
 * `UPSTREAM_UNREACHABLE` (#1226). Neither the coordinator nor its client sets a
 * gRPC deadline (#722), so this is the only bound on a user's wait.
 *
 * It lets the BoardGameGeek DataGateway wait out one 429 and ask again (a wait
 * of up to 30 s), which is how it rides out a short throttle, and stays under
 * the 60 s a reverse proxy commonly waits for an answer (nginx's
 * `proxy_read_timeout`), so the user hears this server's code rather than a
 * proxy's 504. Only a lookup that is both throttled and kept waiting by
 * BoardGameGeek's "still preparing" answers (up to 30 s more) runs past it.
 * An answer after the bound is dropped, nothing is linked, and the user can
 * try again.
 */
export const BGG_LOOKUP_TIMEOUT_MS = 50_000;

/** The refusal a lookup that failed, or had no usable answer, ends in. */
function unreachable(): CodedHttpException {
  return new CodedHttpException(
    Http.ServiceUnavailable,
    UpstreamAccountErrorCode.Unreachable,
    t('errors.upstream_account.unreachable', { upstream: Upstream.BoardGameGeek }),
  );
}

/**
 * Linking a BoardGameGeek account by username (#1226).
 *
 * BoardGameGeek offers no sign-in another site can use, so a username can
 * only be typed, never proved. The server checks that BoardGameGeek has a
 * user by that name, asking through the DataGateway the link goes through
 * (BoardGameGeek's API needs the operator's key, which the DataGateway holds),
 * and stores the account unverified, with the username as BoardGameGeek
 * writes it and the address of the user's profile there. Nothing treats it as
 * proof of who someone is.
 *
 * Any number of users may link the same username, and nothing tells either
 * of them: refusing the second would let anyone take another person's
 * username first, and telling either would reveal the other's link. So
 * nothing here reads who else has the username, every answer and log line is
 * the same whoever else linked it, and the username stays out of the log.
 */
@Injectable()
export class BggLinkService {
  private readonly logger = new Logger(BggLinkService.name);

  constructor(
    private readonly upstreamAccounts: UpstreamAccountService,
    private readonly coordinator: GatewayCoordinatorClientService,
  ) {}

  /**
   * Links `username`'s BoardGameGeek account to `userId`, unverified, once a
   * DataGateway is usable for the link (else 409 `UPSTREAM_NOT_LINKABLE`),
   * the user has no BoardGameGeek account (else 409
   * `UPSTREAM_ACCOUNT_ALREADY_LINKED`), and BoardGameGeek has a user by that
   * name (else 404 `UPSTREAM_ACCOUNT_UNKNOWN_USERNAME`). A throttled
   * DataGateway answers 503 `UPSTREAM_THROTTLED` with `retryAfterMs`; a
   * lookup that fails or doesn't answer within {@link BGG_LOOKUP_TIMEOUT_MS}
   * answers 503 `UPSTREAM_UNREACHABLE`.
   */
  async link(userId: string, username: string): Promise<UpstreamAccount> {
    const dataGateway = await this.upstreamAccounts.linkDataGateway(Upstream.BoardGameGeek);
    await this.upstreamAccounts.assertNotLinked(userId, Upstream.BoardGameGeek);
    const account = await this.lookUp(userId, dataGateway.id, username);

    return this.upstreamAccounts.create({
      userId,
      upstream: Upstream.BoardGameGeek,
      externalId: account.externalId,
      // The name BoardGameGeek shows, which is the username again: the audit
      // log leaves it out with the external id, so unlinking deletes the
      // username, as the privacy policy says (#935).
      displayName: account.displayName || null,
      profileUrl: httpAddress(account.profileUrl)?.href ?? null,
      verified: false,
    });
  }

  /** The account BoardGameGeek has by `username`, or the refusal its answer means. */
  private async lookUp(userId: string, gatewayId: string, username: string): Promise<UpstreamAccountData> {
    const answer = await this.ask(userId, gatewayId, username);
    if (answer === null) {
      throw unreachable();
    }

    switch (answer.status) {
      case ResultStatus.RESULT_STATUS_RESULT: {
        if (answer.account?.externalId) {
          return answer.account;
        }

        this.logger.error(`DataGateway ${gatewayId} answered a BoardGameGeek lookup with no account`);
        break;
      }

      case ResultStatus.RESULT_STATUS_NOT_FOUND: {
        throw new CodedHttpException(
          Http.NotFound,
          UpstreamAccountErrorCode.UnknownUsername,
          t('errors.upstream_account.unknown_username', { upstream: Upstream.BoardGameGeek }),
        );
      }

      case ResultStatus.RESULT_STATUS_RATE_LIMITED: {
        const throttled = new UpstreamThrottledException(Upstream.BoardGameGeek, answer.retryAfterMs);
        this.logger.warn(
          `DataGateway ${gatewayId} is throttled; a BoardGameGeek link waits ${throttled.retryAfterSeconds} s`,
        );

        throw throttled;
      }

      default: {
        // The DataGateway's message stays out: it may quote the username.
        this.logger.error(`DataGateway ${gatewayId} answered a BoardGameGeek lookup with ${answer.status}`);
      }
    }

    throw unreachable();
  }

  /**
   * Asks the DataGateway, through the coordinator, as live traffic: the
   * user is waiting. Null when the call fails, ends with no answer, or
   * hasn't answered within {@link BGG_LOOKUP_TIMEOUT_MS}; the timeout
   * unsubscribes, which cancels the call.
   */
  private async ask(
    userId: string,
    gatewayId: string,
    username: string,
  ): Promise<CoordinatorFindUpstreamAccountResponse | null> {
    const correlationId = crypto.randomUUID();

    try {
      return await firstValueFrom(
        defer(() => this.coordinator.findUpstreamAccount({ correlationId, gatewayId, username })).pipe(
          timeout({ first: BGG_LOOKUP_TIMEOUT_MS }),
        ),
      );
    } catch (error) {
      // A failed call's error is the transport's or the timeout's, and
      // carries no part of the request.
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.logger.error(
        `A BoardGameGeek lookup for user ${userId} through DataGateway ${gatewayId} failed ` +
          `(correlationId ${correlationId}): ${reason}`,
      );

      return null;
    }
  }
}
