import { Action, ResourceType } from '@bge/database';
import { HouseholdLivenessGuard, HouseholdPathParam } from '@bge/household';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { ApiPaginatedEnvelope, DefaultPaginationQueryDto, paginated } from '@bge/shared';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { EventService } from './event.service';

/**
 * A household's upcoming events, addressed under the household (#506). The
 * events leave `GET /events` for a route of their own, since that list is
 * first-person (#512).
 *
 * The liveness guard answers 404 for a missing or deleted household, ahead of
 * `PoliciesGuard`. It passes an actor who can't read `Household`, such as an
 * API key scoped to events, and a soft delete leaves the household's events
 * live (#992), so the service's scope checks the household as well. Without it,
 * such a key would list a deleted household's events.
 *
 * An empty page is a 200 with no check for hidden rows. A household always has
 * members, so a 403 on the members route gives nothing away, but here it would
 * tell a stranger the household has events.
 *
 * Must stay out of the response cache. The rows depend on the actor's access
 * and the household's dates, either of which can change without the actor
 * doing anything, and would otherwise go unseen for the cache TTL.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('events')
@HouseholdPathParam('householdId')
@UseGuards(HouseholdLivenessGuard, PoliciesGuard)
@Controller('households/:householdId/events')
export class HouseholdEventsController {
  constructor(private readonly eventService: EventService) {}

  @ApiOperation({
    summary: "List a household's upcoming events",
    description:
      'A household’s upcoming events, whether or not the acting user attends them: not cancelled, archived or ' +
      'deleted, with a confirmed date that hasn’t ended, soonest first, then by id. Events still choosing a ' +
      'date and past events are left out. Limited by what the actor may read: someone outside the household ' +
      'sees its Public events and any others open to them, and an empty list says nothing about what else it ' +
      'has. Each row is a `GET /events` row. Its `attendance` is `null` when the acting user doesn’t attend or ' +
      'was removed, or when the actor doesn’t have permission to read attendees, so `null` alone doesn’t mean ' +
      'the user can join. A missing or deleted household answers 404, except to an actor without permission to ' +
      'read households, such as an API key scoped to events or a plugin, which gets an empty list. Paginated: ' +
      '`?page=` (1-based) and `?limit=`, with a `pagination` envelope.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiPaginatedEnvelope('events')
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Household not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Event))
  @Get()
  getHouseholdEvents(@Param('householdId') householdId: string, @Query() query: DefaultPaginationQueryDto) {
    return from(this.eventService.getHouseholdEvents(householdId, query)).pipe(
      map((page) => paginated('events', page, query, ResourceType.Event)),
    );
  }
}
