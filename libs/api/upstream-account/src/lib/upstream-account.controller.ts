import { Action, ResourceType } from '@bge/database';
import type { I18nMessage } from '@bge/i18n';
import { CodedHttpException, t } from '@bge/i18n';
import { AbilityService, CheckPolicies, PoliciesGuard, resolveScopeSubjectId, ScopeComposer } from '@bge/permissions';
import { Controller, Delete, Get, Headers, Param, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { Http } from '@status/codes';
import { toUpstreamAccountDto, UPSTREAM_KEY_VALUES } from './dto/upstream-account.dto';
import { UpstreamAccountsResponseDto } from './dto/upstream-accounts-response.dto';
import { UpstreamAccountErrorCode } from './upstream-account.constants';
import { UpstreamAccountService } from './upstream-account.service';
import { UPSTREAM_KEYS, upstreamFromKey } from './upstream-keys';

/**
 * The user's own upstream accounts (#935), self-addressed under `/users/me`
 * as `users/me/plugins` is: the acting user is the only one whose accounts
 * are addressable. Each route composes its scope as the user's own accounts,
 * which the caller's ability clips, so an API key acts within its own scopes.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
@ApiTags('upstream-accounts')
@Controller('users/me/upstream-accounts')
export class UpstreamAccountController {
  constructor(
    private readonly upstreamAccounts: UpstreamAccountService,
    private readonly abilityService: AbilityService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  /**
   * Stays out of the response cache: an unlink, and a link, must show on the
   * next read.
   */
  @ApiOperation({
    summary: 'List your upstream accounts',
    description:
      'Your accounts at the upstreams DataGateways serve, such as Steam, with the upstreams you can link an ' +
      'account at now and the privacy policy a client shows before a link: its address, and the language and ' +
      'date of the policy you would read there.',
  })
  @ApiHeader({
    name: 'Accept-Language',
    required: false,
    description: "Chooses the privacy policy's language when you have stored none, as `GET /api/privacy-policy` does.",
  })
  @ApiOkResponse({ type: UpstreamAccountsResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions, or an actor with no user behind it' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.UpstreamAccount))
  @Get()
  async list(@Headers('accept-language') acceptLanguage: string | undefined): Promise<UpstreamAccountsResponseDto> {
    const userId = resolveScopeSubjectId(this.abilityService);
    const scope = this.scopeComposer.compose(ResourceType.UpstreamAccount, Action.read, { userId });

    const [accounts, linkable, privacyPolicy] = await Promise.all([
      this.upstreamAccounts.list(userId, scope),
      this.upstreamAccounts.linkableUpstreams(),
      this.upstreamAccounts.privacyPolicy(userId, acceptLanguage),
    ]);

    return {
      upstreamAccounts: accounts.map(toUpstreamAccountDto),
      linkableUpstreams: linkable.map((upstream) => UPSTREAM_KEYS[upstream]),
      privacyPolicy,
    };
  }

  @ApiOperation({
    summary: 'Unlink your upstream account',
    description:
      'Deletes your account at the upstream, with its sync history. The games already in your collection stay. ' +
      'An account can be unlinked whether or not its upstream can still be linked.',
  })
  @ApiParam({
    name: 'upstream',
    enum: UPSTREAM_KEY_VALUES,
    description: 'The upstream whose account to unlink, by its well-known key.',
  })
  @ApiOkResponse({ description: 'Unlinked: `{ message }`.' })
  @ApiResponse({
    status: Http.BadRequest,
    description: `The key names no upstream (code ${UpstreamAccountErrorCode.UnknownUpstream})`,
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions, or an actor with no user behind it' })
  @ApiResponse({
    status: Http.NotFound,
    description: `You have no account at that upstream (code ${UpstreamAccountErrorCode.NotFound})`,
  })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.UpstreamAccount))
  @Delete(':upstream')
  async unlink(@Param('upstream') key: string): Promise<{ message: I18nMessage }> {
    // Resolved before the key is parsed so an actor with no user gets the same 403 whatever key it sends.
    const userId = resolveScopeSubjectId(this.abilityService);
    const upstream = upstreamFromKey(key);
    if (upstream === null) {
      throw new CodedHttpException(
        Http.BadRequest,
        UpstreamAccountErrorCode.UnknownUpstream,
        t('errors.upstream_account.unknown_upstream', { key, keys: UPSTREAM_KEY_VALUES.join(', ') }),
      );
    }

    const scope = this.scopeComposer.compose(ResourceType.UpstreamAccount, Action.delete, { userId });
    await this.upstreamAccounts.unlink(userId, upstream, scope);

    return { message: t('success.upstream_account.unlinked', { upstream }) };
  }
}
