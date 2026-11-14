import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { UpdateEventPolicyDto } from './dto/update-event-policy.dto';
import { UpdateOccurrencePolicyDto } from './dto/update-occurrence-policy.dto';
import { EventPolicyService } from './event-policy.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('event-policy')
@UseGuards(PoliciesGuard)
@ApiParam({ name: 'eventId', type: String })
@Controller('events/:eventId')
export class EventPolicyController {
  constructor(private readonly policyService: EventPolicyService) {}

  @ApiOperation({
    summary: "Change an event's policy",
    description:
      'Changes only the fields sent. A field that can be cleared takes `null`; one that can’t answers 400. ' +
      'Needs permission to update the event’s policy, which the event’s hosts and the household’s ' +
      'owners and admins hold; permission to update the event isn’t enough. The policy is judged as the patch ' +
      'leaves it, merged with what is stored and with each date’s overrides: a Supermajority or FixedCount ' +
      'threshold, or a PercentOfAttendees or FixedCount quorum, needs its value sent or already stored, and ' +
      'answers 400 `EVENT_POLICY_INVALID` otherwise. A change leaves work in flight as it is: an open nomination ' +
      'finishes the process it started in, a resolve uses the policy in force when it runs, and a voting deadline ' +
      'already set stays. `policy` is `null` when the caller may change the policy but not read it (#796). ' +
      'Each allowed list (`allowedPlatformTypes`, `allowedPlatformIds`, `allowedCategoryIds`) sent replaces the ' +
      'stored one, `[]` clears it, and one left out stays; an id that names no platform or category answers 400 ' +
      '`EVENT_POLICY_UNKNOWN_REFERENCE` (#1268). `occurrenceOverrideScope` says how far a date’s own policy may ' +
      'override the allowed lists and capacity. A change to it, or to a restriction, that would leave a date ' +
      'past it answers 400 `EVENT_POLICY_OCCURRENCES_EXCEED_SCOPE`, with those dates’ ids in `occurrenceIds`; ' +
      'change those dates first (#796).',
  })
  @ApiResponse({ status: Http.Ok, description: 'Event policy updated' })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'Invalid patch, or a vote threshold or quorum left without a value (code EVENT_POLICY_INVALID); a platform ' +
      'or category id that names none (code EVENT_POLICY_UNKNOWN_REFERENCE); or a change that would leave a ' +
      'date’s own policy past the override scope (code EVENT_POLICY_OCCURRENCES_EXCEED_SCOPE, with ' +
      '`occurrenceIds`)',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.EventPolicy))
  @Patch('policy')
  updatePolicy(@Param('eventId') eventId: string, @Body() dto: UpdateEventPolicyDto) {
    return from(this.policyService.updatePolicy(eventId, dto)).pipe(
      map((policy) => ({ message: t('success.event_policy.updated'), policy })),
    );
  }

  @ApiOperation({
    summary: "Change a date's own policy",
    description:
      'Sets what one date overrides of the event’s policy, for that day. Changes only the fields sent. Every ' +
      'field takes `null`, which hands it back to the event’s; the three “no restriction” flags take `false` ' +
      'instead, and `null` answers 400. The date’s policy is made on its first change. Needs permission to ' +
      'update the event’s policy, as the event’s policy route does; permission to update the date isn’t ' +
      'enough. Each allowed list (`allowedPlatformTypes`, `allowedPlatformIds`, `allowedCategoryIds`) sent ' +
      'replaces the date’s, `[]` hands it back to the event’s, and one left out stays; an id that names no ' +
      'platform or category answers 400 `EVENT_POLICY_UNKNOWN_REFERENCE` (#1268). The date’s policy is ' +
      'judged as the patch leaves it, merged with what the date already sets and folded over the event’s ' +
      'policy: a vote threshold or quorum the date leaves without a value, its own or the event’s, answers 400 ' +
      '`EVENT_POLICY_INVALID`. How far the date may change the allowed lists and capacity is the event’s ' +
      '`occurrenceOverrideScope`: under `None` it may change none of them, under `TightenOnly` it may only ' +
      'narrow them, and only under `Any` may it replace them or lift them with `platformTypesUnrestricted`, ' +
      '`platformsUnrestricted` or `capacityUnrestricted`. A change past the scope answers 400 ' +
      '`EVENT_OCCURRENCE_OVERRIDE_NOT_ALLOWED`. A flag beside a restriction of its kind on the same date ' +
      'answers 400 `EVENT_POLICY_INVALID` under any scope. Nominations for the date are held to its policy ' +
      'from then on; work in flight is left as it is, as for the event’s policy. `policy` is `null` when the ' +
      'caller may change the event’s policy but not read it (#796).',
  })
  @ApiParam({ name: 'occurrenceId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Occurrence policy updated' })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'Invalid patch, a vote threshold or quorum left without a value, or a “no restriction” flag beside a ' +
      'list or limit of its kind (code EVENT_POLICY_INVALID); a change past the event’s override scope (code ' +
      'EVENT_OCCURRENCE_OVERRIDE_NOT_ALLOWED); or a platform or category id that names none (code ' +
      'EVENT_POLICY_UNKNOWN_REFERENCE)',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found, or the date is not one of its dates' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.EventPolicy))
  @Patch('occurrences/:occurrenceId/policy')
  updateOccurrencePolicy(
    @Param('eventId') eventId: string,
    @Param('occurrenceId') occurrenceId: string,
    @Body() dto: UpdateOccurrencePolicyDto,
  ) {
    return from(this.policyService.updateOccurrencePolicy(eventId, occurrenceId, dto)).pipe(
      map((policy) => ({ message: t('success.occurrence_policy.updated'), policy })),
    );
  }
}
