import { Action, ResourceType } from '@bge/database';
import { DEFAULT_REVIEW_STATUSES, LanguageLinkReviewService, type LanguageLinkView } from '@bge/language';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { paginated, PaginatedResponseDto, Unscoped } from '@bge/shared';
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from, type Observable } from 'rxjs';
import { concatMap, map } from 'rxjs/operators';
import { DataGatewayService } from './data-gateway.service';
import { LanguageLinkEnvelopeDto, LanguageLinkQueryDto, LanguageLinkResponseDto, LinkLanguageLinkDto } from './dto';

const PaginatedLanguageLinksResponse = PaginatedResponseDto(LanguageLinkResponseDto, 'languageLinks');

/**
 * Review of a DataGateway's language links (#715): the worklist, and link,
 * ignore and accept. Gated as the other DataGateway routes are, read for the
 * list and update for the actions.
 *
 * Every route checks the DataGateway first. Links carry no foreign key to it,
 * so a deleted DataGateway's links remain, and without the check its routes
 * would still list and settle them.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
@ApiTags('data-gateways')
@Controller('data-gateways/:id/language-links')
export class DataGatewayLanguageLinkController {
  constructor(
    private readonly dataGatewayService: DataGatewayService,
    private readonly review: LanguageLinkReviewService,
  ) {}

  @ApiOperation({
    summary: "List a DataGateway's language links",
    description:
      'The ones waiting on a review by default: Pending and Unresolved. `?status=` lists others. Ordered by value, ' +
      'and paginated like the other lists.',
  })
  @ApiResponse({ status: Http.Ok, type: PaginatedLanguageLinksResponse })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'No such DataGateway, or it was deleted' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.DataGateway))
  @Get()
  list(@Param('id') id: string, @Query() query: LanguageLinkQueryDto) {
    return this.forDataGateway(id, () => this.review.list(id, query.status ?? DEFAULT_REVIEW_STATUSES, query)).pipe(
      map((page) =>
        paginated(
          'languageLinks',
          page,
          query,
          Unscoped(
            'language links have no resource type of their own: the route is gated by read on DataGateway, and ' +
              'every catalog role that reads DataGateways reads every row (KNOWN_READ_CEILINGS)',
          ),
        ),
      ),
    );
  }

  @ApiOperation({ summary: 'Link a language link to a language tag', description: 'Whatever its status.' })
  @ApiResponse({ status: Http.Ok, type: LanguageLinkEnvelopeDto })
  @ApiResponse({ status: Http.BadRequest, description: 'No such language tag' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: "No such DataGateway, or no such link of this DataGateway's" })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.DataGateway))
  @HttpCode(Http.Ok)
  @Post(':linkId/link')
  link(@Param('id') id: string, @Param('linkId') linkId: string, @Body() body: LinkLanguageLinkDto) {
    return this.answer(id, () => this.review.link(id, linkId, body.tagId));
  }

  @ApiOperation({
    summary: 'Ignore a language link',
    description: 'Whatever its status. Interviews and imports leave an Ignored link alone.',
  })
  @ApiResponse({ status: Http.Ok, type: LanguageLinkEnvelopeDto })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: "No such DataGateway, or no such link of this DataGateway's" })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.DataGateway))
  @HttpCode(Http.Ok)
  @Post(':linkId/ignore')
  ignore(@Param('id') id: string, @Param('linkId') linkId: string) {
    return this.answer(id, () => this.review.ignore(id, linkId));
  }

  @ApiOperation({
    summary: 'Accept a Pending language link',
    description: 'Adds its language and tag when they are missing, and links it to the tag.',
  })
  @ApiResponse({ status: Http.Ok, type: LanguageLinkEnvelopeDto })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: "No such DataGateway, or no such link of this DataGateway's" })
  @ApiResponse({ status: Http.Conflict, description: 'The link is not Pending, or names no registered language' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.DataGateway))
  @HttpCode(Http.Ok)
  @Post(':linkId/accept')
  accept(@Param('id') id: string, @Param('linkId') linkId: string) {
    return this.answer(id, () => this.review.accept(id, linkId));
  }

  private answer(id: string, act: () => Promise<LanguageLinkView>) {
    return this.forDataGateway(id, act).pipe(map((languageLink) => ({ languageLink })));
  }

  /** Runs `act` once the DataGateway is found: 404 for one unknown or deleted. */
  private forDataGateway<T>(id: string, act: () => Promise<T>): Observable<T> {
    return from(this.dataGatewayService.getById(id)).pipe(concatMap(() => from(act())));
  }
}
