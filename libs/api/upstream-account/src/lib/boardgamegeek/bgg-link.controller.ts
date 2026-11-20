import { AuditContextService, requireSessionUserId } from '@bge/actor-context';
import type { UpstreamAccount } from '@bge/database';
import { Action, ResourceType, Upstream } from '@bge/database';
import type { I18nMessage } from '@bge/i18n';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import type { Response } from 'express';
import type { UpstreamAccountDto } from '../dto/upstream-account.dto';
import { toUpstreamAccountDto } from '../dto/upstream-account.dto';
import { UpstreamAccountErrorCode } from '../upstream-account.constants';
import { UpstreamThrottledException } from '../upstream-throttled.exception';
import { BGG_LOOKUP_TIMEOUT_MS, BggLinkService } from './bgg-link.service';
import { LinkByUsernameDto, UpstreamAccountLinkedResponseDto } from './dto/link-by-username.dto';

/**
 * Linking your BoardGameGeek account by username (#1226).
 *
 * The route takes only a registered user's own session, as linking a Steam
 * account does: an API key acts for its owner but is not the owner, and an
 * anonymous user's identity is only temporary. The client shows the privacy
 * policy the list answers before it sends the username (#934).
 */
@ApiTags('upstream-accounts')
@UseGuards(PoliciesGuard)
@Controller('users/me/upstream-accounts/boardgamegeek')
export class BggLinkController {
  constructor(
    private readonly bggLink: BggLinkService,
    private readonly auditContext: AuditContextService,
  ) {}

  @ApiOperation({
    summary: 'Link your BoardGameGeek account by username',
    description:
      'Checks, through a DataGateway, that BoardGameGeek has a user with this username, and links that account ' +
      'to you, unverified: BoardGameGeek has no way to confirm an account is yours, so nothing on this server ' +
      'treats it as proof of who you are. Other users may link the same username, and neither of you is told. ' +
      'This server never asks for your BoardGameGeek password. Show the privacy policy that ' +
      '`GET /api/users/me/upstream-accounts` answers before sending the username. Waits up to ' +
      `${BGG_LOOKUP_TIMEOUT_MS / 1000} seconds for BoardGameGeek. Needs a signed-in user's own session: an API key ` +
      'or an anonymous user gets 403.',
  })
  @ApiBearerAuth()
  @ApiCreatedResponse({ type: UpstreamAccountLinkedResponseDto })
  @ApiResponse({ status: Http.BadRequest, description: 'The username is empty after trimming, or too long' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description: "Insufficient permissions, or not a registered user's own session: an API key or an anonymous user",
  })
  @ApiResponse({
    status: Http.NotFound,
    description: `BoardGameGeek has no user with that username (code ${UpstreamAccountErrorCode.UnknownUsername})`,
  })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'No enabled DataGateway for BoardGameGeek can look a username up ' +
      `(code ${UpstreamAccountErrorCode.NotLinkable}), or you already have a BoardGameGeek account linked: unlink ` +
      `it first (code ${UpstreamAccountErrorCode.AlreadyLinked})`,
  })
  @ApiResponse({
    status: Http.ServiceUnavailable,
    description:
      'Nothing was linked. BoardGameGeek is getting too many requests from this server: try again after ' +
      `\`retryAfterMs\` milliseconds, also sent as the \`Retry-After\` header in seconds ` +
      `(code ${UpstreamAccountErrorCode.Throttled}); or BoardGameGeek could not be ` +
      `reached, or didn't answer in time (code ${UpstreamAccountErrorCode.Unreachable})`,
  })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.UpstreamAccount))
  @Post()
  async link(
    @Body() body: LinkByUsernameDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ message: I18nMessage; upstreamAccount: UpstreamAccountDto }> {
    const userId = requireSessionUserId(this.auditContext.getActor());

    let account: UpstreamAccount;
    try {
      account = await this.bggLink.link(userId, body.username);
    } catch (error) {
      // A throttled link's wait goes in the header too, in seconds, for a
      // client or proxy that reads only the header (#1226).
      if (error instanceof UpstreamThrottledException) {
        response.setHeader('Retry-After', String(error.retryAfterSeconds));
      }

      throw error;
    }

    return {
      message: t('success.upstream_account.linked_by_username', { upstream: Upstream.BoardGameGeek }),
      upstreamAccount: toUpstreamAccountDto(account),
    };
  }
}
