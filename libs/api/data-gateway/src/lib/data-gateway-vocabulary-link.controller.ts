import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { paginated, PaginatedResponseDto, Unscoped } from '@bge/shared';
import {
  DEFAULT_VOCABULARY_REVIEW_STATUSES,
  VocabularyLinkReviewService,
  type ReviewedVocabularyKind,
  type VocabularyLinkView,
} from '@bge/vocabulary';
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards, type Type } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from, type Observable } from 'rxjs';
import { concatMap, map } from 'rxjs/operators';
import { DataGatewayService } from './data-gateway.service';
import {
  LinkVocabularyLinkDto,
  VocabularyLinkEnvelopeDto,
  VocabularyLinkQueryDto,
  VocabularyLinkResponseDto,
} from './dto';

/** The review routes each kind of link has. */
export interface VocabularyLinkRoutes {
  list(id: string, query: VocabularyLinkQueryDto): Observable<unknown>;
  link(id: string, linkId: string, body: LinkVocabularyLinkDto): Observable<unknown>;
  ignore(id: string, linkId: string): Observable<unknown>;
  accept(id: string, linkId: string): Observable<unknown>;
}

const NAMES: Readonly<Record<ReviewedVocabularyKind, { record: string; controller: string }>> = {
  platform: { record: 'platform', controller: 'DataGatewayPlatformLinkController' },
  category: { record: 'category', controller: 'DataGatewayCategoryLinkController' },
  mechanic: { record: 'mechanic', controller: 'DataGatewayMechanicLinkController' },
};

/**
 * One review controller per kind of link, so the three share their gating
 * and 404 rule (#715, #718): the worklist, and link, ignore and accept, as
 * the language links have. Gated as the other DataGateway routes are, read
 * for the list and update for the actions.
 *
 * Every route checks the DataGateway first. Links carry no foreign key to it,
 * so a deleted DataGateway's links remain, and without the check its routes
 * would still list and settle them.
 */
export function VocabularyLinkController(kind: ReviewedVocabularyKind): Type<VocabularyLinkRoutes> {
  const { record } = NAMES[kind];
  const listKey = `${kind}Links`;
  const linkKey = `${kind}Link`;
  const PaginatedLinksResponse = PaginatedResponseDto(VocabularyLinkResponseDto, listKey);
  const LinkEnvelope = VocabularyLinkEnvelopeDto(linkKey);

  @ApiBearerAuth()
  @ApiSecurity('api_key')
  @UseGuards(PoliciesGuard)
  @ApiTags('data-gateways')
  @Controller(`data-gateways/:id/${kind}-links`)
  class DataGatewayVocabularyLinkController implements VocabularyLinkRoutes {
    constructor(
      readonly dataGatewayService: DataGatewayService,
      readonly review: VocabularyLinkReviewService,
    ) {}

    @ApiOperation({
      summary: `List a DataGateway's ${record} links`,
      description:
        'The ones waiting on a review by default: Pending. `?status=` lists others. Ordered by the name the ' +
        'DataGateway sent, and paginated like the other lists.',
    })
    @ApiResponse({ status: Http.Ok, type: PaginatedLinksResponse })
    @ApiResponse({ status: 401, description: 'Authentication required' })
    @ApiResponse({ status: 403, description: 'Insufficient permissions' })
    @ApiResponse({ status: Http.NotFound, description: 'No such DataGateway, or it was deleted' })
    @CheckPolicies((ability) => ability.can(Action.read, ResourceType.DataGateway))
    @Get()
    list(@Param('id') id: string, @Query() query: VocabularyLinkQueryDto) {
      return this.forDataGateway(id, Action.read, () =>
        this.review.list(kind, id, query.status ?? DEFAULT_VOCABULARY_REVIEW_STATUSES, query),
      ).pipe(
        map((page) =>
          paginated(
            listKey,
            page,
            query,
            Unscoped(
              `${record} links have no resource type of their own: the route is gated by read on DataGateway, and ` +
                'every catalog role that reads DataGateways reads every row (KNOWN_READ_CEILINGS)',
            ),
          ),
        ),
      );
    }

    @ApiOperation({ summary: `Link a ${record} link to a ${record}`, description: 'Whatever its status.' })
    @ApiResponse({ status: Http.Ok, type: LinkEnvelope })
    @ApiResponse({ status: Http.BadRequest, description: `No such ${record}` })
    @ApiResponse({ status: 401, description: 'Authentication required' })
    @ApiResponse({ status: 403, description: 'Insufficient permissions' })
    @ApiResponse({ status: Http.NotFound, description: "No such DataGateway, or no such link of this DataGateway's" })
    @CheckPolicies((ability) => ability.can(Action.update, ResourceType.DataGateway))
    @HttpCode(Http.Ok)
    @Post(':linkId/link')
    link(@Param('id') id: string, @Param('linkId') linkId: string, @Body() body: LinkVocabularyLinkDto) {
      return this.answer(id, () => this.review.link(kind, id, linkId, body.recordId));
    }

    @ApiOperation({
      summary: `Ignore a ${record} link`,
      description:
        'Whatever its status. Imports leave an Ignored link’s entry out, and list jobs leave the link alone.',
    })
    @ApiResponse({ status: Http.Ok, type: LinkEnvelope })
    @ApiResponse({ status: 401, description: 'Authentication required' })
    @ApiResponse({ status: 403, description: 'Insufficient permissions' })
    @ApiResponse({ status: Http.NotFound, description: "No such DataGateway, or no such link of this DataGateway's" })
    @CheckPolicies((ability) => ability.can(Action.update, ResourceType.DataGateway))
    @HttpCode(Http.Ok)
    @Post(':linkId/ignore')
    ignore(@Param('id') id: string, @Param('linkId') linkId: string) {
      return this.answer(id, () => this.review.ignore(kind, id, linkId));
    }

    @ApiOperation({
      summary: `Accept a Pending ${record} link`,
      description: `Links it to the ${record} of the same name, or adds one from what the DataGateway sent.`,
    })
    @ApiResponse({ status: Http.Ok, type: LinkEnvelope })
    @ApiResponse({ status: 401, description: 'Authentication required' })
    @ApiResponse({ status: 403, description: 'Insufficient permissions' })
    @ApiResponse({ status: Http.NotFound, description: "No such DataGateway, or no such link of this DataGateway's" })
    @ApiResponse({ status: Http.Conflict, description: 'The link is not Pending' })
    @CheckPolicies((ability) => ability.can(Action.update, ResourceType.DataGateway))
    @HttpCode(Http.Ok)
    @Post(':linkId/accept')
    accept(@Param('id') id: string, @Param('linkId') linkId: string) {
      return this.answer(id, () => this.review.accept(kind, id, linkId));
    }

    private answer(id: string, act: () => Promise<VocabularyLinkView>) {
      return this.forDataGateway(id, Action.update, act).pipe(map((link) => ({ [linkKey]: link })));
    }

    /**
     * Runs `act` once the DataGateway is found under `action`, the route's own:
     * 404 for one unknown, deleted, or out of the caller's reach for it.
     */
    private forDataGateway<T>(id: string, action: Action, act: () => Promise<T>): Observable<T> {
      return from(this.dataGatewayService.getById(id, action)).pipe(concatMap(() => from(act())));
    }
  }

  // Swagger names each route's operation by its controller, so each kind's needs a name of its own.
  Object.defineProperty(DataGatewayVocabularyLinkController, 'name', { value: NAMES[kind].controller });

  return DataGatewayVocabularyLinkController;
}

export const DataGatewayPlatformLinkController = VocabularyLinkController('platform');
export const DataGatewayCategoryLinkController = VocabularyLinkController('category');
export const DataGatewayMechanicLinkController = VocabularyLinkController('mechanic');
