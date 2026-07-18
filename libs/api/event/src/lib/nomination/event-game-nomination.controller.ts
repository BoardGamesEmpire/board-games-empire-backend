import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Get, Logger, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { CastVoteDto } from '../dto/cast-vote.dto';
import { DirectAddGameDto } from './dto/direct-add-game.dto';
import { NominateGameDto } from './dto/nominate-game.dto';
import { EventGameNominationService } from './event-game-nomination.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('event-game-nominations')
@ApiParam({ name: 'eventId', type: String })
@UseGuards(PoliciesGuard)
@Controller('events/:eventId/nominations')
export class EventGameNominationController {
  private readonly logger = new Logger(EventGameNominationController.name);

  constructor(private readonly nominationService: EventGameNominationService) {}

  @ApiOperation({ summary: 'List nominations for an event' })
  @ApiResponse({ status: Http.Ok, description: 'Nominations retrieved' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.EventGameNomination))
  @Get()
  getNominations(@Param('eventId') eventId: string) {
    return from(this.nominationService.getNominations(eventId)).pipe(map((nominations) => ({ nominations })));
  }

  @ApiOperation({ summary: 'Get a single nomination' })
  @ApiParam({ name: 'nominationId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Nomination retrieved' })
  @ApiResponse({ status: Http.NotFound, description: 'Nomination not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.EventGameNomination))
  @Get(':nominationId')
  getNomination(@Param('eventId') eventId: string, @Param('nominationId') nominationId: string) {
    return from(this.nominationService.getNomination(eventId, nominationId)).pipe(
      map((nomination) => ({ nomination })),
    );
  }

  @ApiOperation({ summary: 'Nominate a game for the event' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiResponse({ status: Http.Created, description: 'Nomination created' })
  @ApiResponse({ status: Http.Forbidden, description: 'Mode does not allow nominations' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.EventGameNomination))
  @Post()
  nominate(@Param('eventId') eventId: string, @Body() dto: NominateGameDto) {
    return from(this.nominationService.nominate(eventId, dto)).pipe(
      tap((nomination) =>
        this.logger.log(`Nomination ${nomination.id} created for event ${eventId} by ${nomination.nominatedById}`),
      ),
      map((nomination) => ({
        message: t('success.nomination.created'),
        nomination,
      })),
    );
  }

  @ApiOperation({ summary: 'Withdraw your nomination' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'nominationId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Nomination withdrawn' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.EventGameNomination))
  @Patch(':nominationId/withdraw')
  withdraw(@Param('eventId') eventId: string, @Param('nominationId') nominationId: string) {
    return from(this.nominationService.withdraw(eventId, nominationId)).pipe(
      tap((nomination) =>
        this.logger.log(`Nomination ${nominationId} withdrawn for event ${eventId} by ${nomination.nominatedById}`),
      ),
      map((nomination) => ({
        message: t('success.nomination.withdrawn'),
        nomination,
      })),
    );
  }

  @ApiOperation({ summary: 'Cast or update your vote on a nomination' })
  @ApiParam({ name: 'nominationId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Vote recorded' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.EventGameVote))
  @Post(':nominationId/votes')
  castVote(@Param('eventId') eventId: string, @Param('nominationId') nominationId: string, @Body() dto: CastVoteDto) {
    return from(this.nominationService.castVote(eventId, nominationId, dto)).pipe(
      tap(() => this.logger.log(`Vote cast on nomination ${nominationId} for event ${eventId}: ${dto.voteType}`)),
      map((vote) => ({ message: t('success.nomination.vote_recorded'), vote })),
    );
  }

  @ApiOperation({ summary: 'Resolve a nomination (tally votes and determine outcome)' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'nominationId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Nomination resolved' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.EventGameNomination))
  @Post(':nominationId/resolve')
  resolve(@Param('eventId') eventId: string, @Param('nominationId') nominationId: string) {
    return from(this.nominationService.resolveNomination(eventId, nominationId)).pipe(
      tap(({ resolution }) => this.logger.log(`Nomination ${nominationId} resolved: ${resolution.status}`)),
      map(({ nomination, resolution }) => ({
        message: t('success.nomination.resolved', { status: resolution.status }),
        nomination,
        resolution,
      })),
    );
  }

  @ApiOperation({ summary: 'Host approves a nomination (HostApproval mode)' })
  @ApiParam({ name: 'nominationId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Nomination approved' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.EventGameNomination))
  @Post(':nominationId/approve')
  hostApprove(@Param('eventId') eventId: string, @Param('nominationId') nominationId: string) {
    return from(this.nominationService.hostApprove(eventId, nominationId)).pipe(
      map((nomination) => ({
        message: t('success.nomination.approved'),
        nomination,
      })),
    );
  }

  @ApiOperation({ summary: 'Host rejects a nomination (HostApproval mode)' })
  @ApiParam({ name: 'nominationId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Nomination rejected' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.EventGameNomination))
  @Post(':nominationId/reject')
  hostReject(@Param('eventId') eventId: string, @Param('nominationId') nominationId: string) {
    return from(this.nominationService.hostReject(eventId, nominationId)).pipe(
      map((nomination) => ({
        message: t('success.nomination.rejected'),
        nomination,
      })),
    );
  }

  @ApiOperation({ summary: 'Directly add a game to the event lineup (Direct/HostOnly mode)' })
  @ApiResponse({ status: Http.Created, description: 'Game added to event' })
  @ApiResponse({ status: Http.Forbidden, description: 'Mode does not permit direct add' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.EventGame))
  @Post('direct-add')
  directAdd(@Param('eventId') eventId: string, @Body() dto: DirectAddGameDto) {
    return from(this.nominationService.directAddGame(eventId, dto)).pipe(
      tap((eventGame) =>
        this.logger.log(
          `Game ${eventGame.platformGameId} directly added to event ${eventId} by ${eventGame.addedById}`,
        ),
      ),
      map((eventGame) => ({
        message: t('success.nomination.game_added'),
        eventGame,
      })),
    );
  }
}
