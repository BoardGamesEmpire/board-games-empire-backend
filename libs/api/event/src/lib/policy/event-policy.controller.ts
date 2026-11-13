import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { UpdateEventPolicyDto } from './dto/update-event-policy.dto';
import { EventPolicyService } from './event-policy.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('event-policy')
@UseGuards(PoliciesGuard)
@ApiParam({ name: 'eventId', type: String })
@Controller('events/:eventId/policy')
export class EventPolicyController {
  constructor(private readonly policyService: EventPolicyService) {}

  @ApiOperation({
    summary: "Change an event's policy",
    description:
      'Changes only the fields sent. A field that can be cleared takes `null`; one that can’t answers 400. ' +
      'Needs permission to update the event’s policy, which the event’s hosts and the household’s ' +
      'owners and admins hold; permission to update the event isn’t enough. The policy is judged as the patch ' +
      'leaves it, merged with what is stored and with each date’s own rules: a Supermajority or FixedCount ' +
      'threshold, or a PercentOfAttendees or FixedCount quorum, needs its value sent or already stored, and ' +
      'answers 400 `EVENT_POLICY_INVALID` otherwise. A change leaves work in flight as it is: an open nomination ' +
      'finishes the process it started in, a resolve uses the policy in force when it runs, and a voting deadline ' +
      'already set stays. `policy` is `null` when the caller may change the policy but not read it (#796).',
  })
  @ApiResponse({ status: Http.Ok, description: 'Event policy updated' })
  @ApiResponse({ status: Http.BadRequest, description: 'Invalid patch, or voting rules left without a value' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.EventPolicy))
  @Patch()
  updatePolicy(@Param('eventId') eventId: string, @Body() dto: UpdateEventPolicyDto) {
    return from(this.policyService.updatePolicy(eventId, dto)).pipe(
      map((policy) => ({ message: t('success.event_policy.updated'), policy })),
    );
  }
}
