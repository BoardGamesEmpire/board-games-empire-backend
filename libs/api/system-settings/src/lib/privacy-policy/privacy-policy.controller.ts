import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
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
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import type { Response } from 'express';
import { PRIVACY_POLICY_LANG_MAX_LENGTH, PrivacyPolicyQueryDto } from './dto/privacy-policy-query.dto';
import { PrivacyPolicyResponseDto } from './dto/privacy-policy.dto';
import { PutPrivacyPolicyDto } from './dto/put-privacy-policy.dto';
import { PRIVACY_POLICY_MAX_LENGTH, PrivacyPolicyErrorCode } from './privacy-policy.constants';
import { PrivacyPolicyService } from './privacy-policy.service';

/** The path parameter both writes take: the language the policy is written in. */
const LANGUAGE_TAG_PARAM = {
  name: 'languageTag',
  type: String,
  description: 'The language tag the policy is written in, such as `de` or `pt-BR`. Its case does not matter.',
  example: 'de',
} as const;

/**
 * The privacy policy (#934): anyone reads it, and a server admin replaces or
 * removes the operator's privacy policy in one language. The class carries no
 * guard and no `AllowAnonymous`, so each route states its own: the read is
 * open, and each write binds `PoliciesGuard` with its `CheckPolicies`.
 */
@ApiTags('privacy-policy')
@Controller('privacy-policy')
export class PrivacyPolicyController {
  constructor(private readonly privacyPolicyService: PrivacyPolicyService) {}

  /**
   * The privacy policy, to anyone, signed in or not (#934). `AllowAnonymous`
   * sits on this handler, not the class, so any other route on this
   * controller needs sign-in.
   *
   * Never served stale. The route stays out of the api's response cache: a
   * server admin re-reads the policy after an edit, and a cached read would
   * show the text from before it for the whole TTL (#530). `no-cache` lets an
   * HTTP cache keep a copy but makes it revalidate on every use, and the ETag
   * Express sets lets an unchanged policy answer 304 without its body.
   */
  @ApiOperation({
    summary: 'Read the privacy policy',
    description:
      'Needs no sign-in. Answers the policy in the best language the server has it in: `lang` first, then ' +
      '`Accept-Language`, then English.',
  })
  @ApiHeader({
    name: 'Accept-Language',
    required: false,
    description: 'The languages the reader prefers, tried after `lang`, in their order of preference.',
  })
  @ApiOkResponse({
    type: PrivacyPolicyResponseDto,
    description: 'The policy: `{ privacyPolicy }`.',
    headers: {
      'Content-Language': { description: 'The language tag the policy is served in.', schema: { type: 'string' } },
    },
  })
  @ApiResponse({
    status: Http.BadRequest,
    description: `A \`lang\` longer than ${PRIVACY_POLICY_LANG_MAX_LENGTH} characters, or an unknown query parameter`,
  })
  @AllowAnonymous()
  @Get()
  @Header('Cache-Control', 'no-cache')
  async read(
    @Query() query: PrivacyPolicyQueryDto,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PrivacyPolicyResponseDto> {
    const privacyPolicy = await this.privacyPolicyService.read({ acceptLanguage, lang: query.lang });
    res.setHeader('Content-Language', privacyPolicy.language);
    // The language depends on Accept-Language; `vary` appends, keeping the Vary values CORS and compression set.
    res.vary('Accept-Language');

    return { privacyPolicy };
  }

  /**
   * Replaces the privacy policy in one language with the operator's (#934).
   * `PoliciesGuard` is bound here, not on the class, so the read stays open:
   * the global auth guard only signs the requester in, and without this guard
   * any signed-in user would pass.
   */
  @ApiOperation({
    summary: 'Replace the privacy policy in one language',
    description:
      'Saves the operator’s privacy policy in a language, which is served from then on in place of the ' +
      'policy file for that language, if there is one. Writing a language again replaces its text; sending ' +
      'the text already saved changes nothing, and its date stays as it was. The ' +
      'language must be one the server knows, though the app need not be translated into it. Needs ' +
      '`manage:privacy_policy`, which server admins hold. Each write is audited.',
  })
  @ApiBearerAuth()
  @ApiSecurity('api_key')
  @ApiParam(LANGUAGE_TAG_PARAM)
  @ApiOkResponse({
    type: PrivacyPolicyResponseDto,
    description: 'The policy as it is now served in that language: `{ privacyPolicy }`.',
  })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      `No \`markdown\`, or an unknown field; \`markdown\` longer than ${PRIVACY_POLICY_MAX_LENGTH} characters ` +
      `(a validation error, or code ${PrivacyPolicyErrorCode.TooLong} where the count is in UTF-16 code ` +
      `units); or Markdown with nothing left once sanitized (code ${PrivacyPolicyErrorCode.Empty})`,
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    description: `The server does not know the language tag (code ${PrivacyPolicyErrorCode.LanguageTagNotFound})`,
  })
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.PrivacyPolicy))
  @Put(':languageTag')
  async replace(
    @Param('languageTag') languageTag: string,
    @Body() dto: PutPrivacyPolicyDto,
  ): Promise<PrivacyPolicyResponseDto> {
    return { privacyPolicy: await this.privacyPolicyService.put(languageTag, dto.markdown) };
  }

  /**
   * Removes the operator's privacy policy in one language (#934), behind
   * `PoliciesGuard` as the replace is.
   */
  @ApiOperation({
    summary: 'Remove the privacy policy in one language',
    description:
      'Removes the operator’s privacy policy saved in a language, so the policy file for that language is ' +
      'served again, or, if there is none, the policy in another language. A policy from the server’s files ' +
      'can’t be removed here. Needs `manage:privacy_policy`, which server admins hold. Each removal is audited.',
  })
  @ApiBearerAuth()
  @ApiSecurity('api_key')
  @ApiParam(LANGUAGE_TAG_PARAM)
  @ApiResponse({ status: Http.NoContent, description: 'Removed' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    description:
      'No privacy policy saved in that language, whether or not the server knows the language tag ' +
      `(code ${PrivacyPolicyErrorCode.NotFound})`,
  })
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.PrivacyPolicy))
  @HttpCode(Http.NoContent)
  @Delete(':languageTag')
  async remove(@Param('languageTag') languageTag: string): Promise<void> {
    await this.privacyPolicyService.remove(languageTag);
  }
}
