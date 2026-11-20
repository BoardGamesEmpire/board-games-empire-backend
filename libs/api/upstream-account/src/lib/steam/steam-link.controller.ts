import type { Actor } from '@bge/actor-context';
import { AuditContextService, isUserActor, requireSessionUserId } from '@bge/actor-context';
import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import type { HttpRedirectResponse } from '@nestjs/common';
import { Body, Controller, Get, Header, Headers, HttpStatus, Post, Redirect, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Http } from '@status/codes';
import { OptionalAuth } from '@thallesp/nestjs-better-auth';
import type { Request } from 'express';
import { UpstreamAccountErrorCode } from '../upstream-account.constants';
import { StartSteamSignInDto } from './dto/start-steam-sign-in.dto';
import { SteamSignInResponseDto } from './dto/steam-sign-in-response.dto';
import { SteamLinkService } from './steam-link.service';

/** The registered user whose session a request came in: null for none, an API key or an anonymous user. */
function sessionUserIdOf(actor: Actor | null): string | null {
  return actor !== null && isUserActor(actor) ? actor.userId : null;
}

/**
 * Linking your Steam account through Steam sign-in (#935): one route starts
 * the sign-in, and Steam sends the browser back to the other.
 *
 * The return is a GET on this server rather than a client page that posts
 * Steam's answer on: Steam shows the user the site they are signing in to,
 * and that is this server's own address. The browser arrives there straight
 * from Steam, carrying the session cookie a top-level navigation sends
 * (SameSite=Lax), and the single-use state the start kept for the user. The
 * return needs both, naming the same user: the state alone could have been
 * handed to someone else, and the session alone could be handed someone
 * else's Steam answer, so either alone would let someone complete a link for
 * another user's account. It answers by sending the browser to the address the
 * client gave when it started, checked then against the trusted origins:
 * nothing in Steam's answer or the query chooses where the browser goes.
 *
 * Both routes take only a registered user's own session. An API key acts for
 * its owner but is not the owner, and has no browser session for the return
 * to find; an anonymous user's identity is only temporary.
 */
@ApiTags('upstream-accounts')
@UseGuards(PoliciesGuard)
@Controller('users/me/upstream-accounts/steam')
export class SteamLinkController {
  constructor(
    private readonly steamLink: SteamLinkService,
    private readonly auditContext: AuditContextService,
  ) {}

  @ApiOperation({
    summary: 'Start linking your Steam account',
    description:
      "Answers Steam's sign-in address, when it stops being usable (30 minutes), and the privacy policy to show " +
      'before sending the browser there. Steam sends the browser back to this server, which links the account ' +
      'and sends it on to `returnTo` with `upstreamAccount=steam` and either `result=linked` or `error=<code>`. ' +
      'Starting again replaces a sign-in you have pending. Needs a signed-in user in the browser that will go to ' +
      'Steam: an API key or an anonymous user gets 403. A client with only a bearer token and no browser session ' +
      "can start the sign-in but can't finish it, because the return needs the browser's session; linking from a " +
      'native app is #1424.',
  })
  @ApiBearerAuth()
  @ApiHeader({
    name: 'Accept-Language',
    required: false,
    description: "Chooses the privacy policy's language when you have stored none, as `GET /api/privacy-policy` does.",
  })
  @ApiCreatedResponse({ type: SteamSignInResponseDto })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      '`returnTo` is not an absolute http or https address at a trusted origin ' +
      `(code ${UpstreamAccountErrorCode.ReturnAddressRefused}), or the body is malformed`,
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description: "Insufficient permissions, or not a registered user's own session: an API key or an anonymous user",
  })
  @ApiResponse({
    status: Http.Conflict,
    description:
      `No enabled DataGateway serves Steam (code ${UpstreamAccountErrorCode.NotLinkable}), or you already have a ` +
      `Steam account linked: unlink it first (code ${UpstreamAccountErrorCode.AlreadyLinked})`,
  })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.UpstreamAccount))
  @Post('sign-in')
  @Header('Cache-Control', 'no-store')
  async startSignIn(
    @Body() body: StartSteamSignInDto,
    @Headers('accept-language') acceptLanguage: string | undefined,
  ): Promise<SteamSignInResponseDto> {
    const userId = requireSessionUserId(this.auditContext.getActor());
    const signIn = await this.steamLink.startSignIn(userId, body.returnTo, acceptLanguage);

    return { signIn };
  }

  /**
   * Reads the request's raw query (#935): Steam's `openid.*` fields would be
   * refused or coerced by the global validation pipe, and the verifier checks
   * them itself. `state` counts only as a single string.
   */
  @ApiOperation({
    summary: 'Finish linking your Steam account',
    description:
      'Where Steam sends the browser back to; not for a client to call. Needs the session that started the ' +
      "sign-in and its state. Sends the browser to the start's `returnTo` with `upstreamAccount=steam` and either " +
      '`result=linked` or `error=<code>`. A state that is missing, unknown, expired or already used has nowhere to ' +
      'send it, and answers 400 instead.',
  })
  @ApiQuery({
    name: 'state',
    required: true,
    description: "The pending sign-in's single-use state, from the return address the start sent Steam.",
  })
  @ApiResponse({
    status: Http.Found,
    description:
      "Sent on to the start's `returnTo`. `result=linked` when the account is linked; otherwise `error` is " +
      `${UpstreamAccountErrorCode.SessionMismatch} (the browser is not signed in as the user who started), ` +
      `${UpstreamAccountErrorCode.Cancelled} (the user cancelled at Steam), ` +
      `${UpstreamAccountErrorCode.NotVerified} (Steam's answer could not be verified), ` +
      `${UpstreamAccountErrorCode.Unreachable} (Steam could not be reached to verify it), ` +
      `${UpstreamAccountErrorCode.AlreadyLinked} (you linked a Steam account meanwhile), or ` +
      `${UpstreamAccountErrorCode.Taken} (another user on this server has linked that Steam account).`,
    headers: { Location: { description: "The start's `returnTo`, with the result.", schema: { type: 'string' } } },
  })
  @ApiResponse({
    status: Http.BadRequest,
    description: `The sign-in is missing, unknown, expired or already used (code ${UpstreamAccountErrorCode.Expired})`,
  })
  @OptionalAuth()
  @Get('return')
  @Header('Cache-Control', 'no-store')
  @Redirect()
  async finishSignIn(@Req() req: Request): Promise<HttpRedirectResponse> {
    const { state } = req.query;
    const url = await this.steamLink.finishSignIn({
      state: typeof state === 'string' ? state : null,
      query: req.query,
      sessionUserId: sessionUserIdOf(this.auditContext.getActor()),
    });

    return { url, statusCode: HttpStatus.FOUND };
  }
}
