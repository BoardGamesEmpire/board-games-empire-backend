import { DatabaseModule } from '@bge/database';
import { InvitesModule } from '@bge/invites';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { PermissionsModule } from '@bge/permissions';
import { QuotaModule } from '@bge/quota';
import { Module } from '@nestjs/common';
import { EventAttendeeController } from './attendee/event-attendee.controller';
import { EventAttendeeService } from './attendee/event-attendee.service';
import { EventController } from './event.controller';
import { EventService } from './event.service';
import { HouseholdEventsController } from './household-events.controller';
import { EventInviteController } from './invite/event-invite.controller';
import { EventInviteService } from './invite/event-invite.service';
import { EventLifecycleController } from './lifecycle/event-lifecycle.controller';
import { EventLifecycleService } from './lifecycle/event-lifecycle.service';
import { LineupController } from './lineup/lineup.controller';
import { LineupService } from './lineup/lineup.service';
import { EventNotificationListener } from './listeners/event-notification.listener';
import { EventGameNominationController } from './nomination/event-game-nomination.controller';
import { EventGameNominationService } from './nomination/event-game-nomination.service';
import { EventOccurrenceController } from './occurrence/event-occurrence.controller';
import { EventOccurrenceService } from './occurrence/event-occurrence.service';
import { OfferedGameController } from './offered-game/offered-game.controller';
import { OfferedGameService } from './offered-game/offered-game.service';
import { EventPolicyController } from './policy/event-policy.controller';
import { EventPolicyService } from './policy/event-policy.service';

@Module({
  // InvitesModule supplies InviteService, the only writer of an invite's
  // status: the event's invite routes create and revoke through it, and the
  // event's delete revokes its outstanding invites (#742). QuotaModule
  // supplies QuotaService to the invite create, which gates
  // `event_invite_daily_count` in its own transaction (#742).
  imports: [DatabaseModule, PermissionsModule, NotificationsServiceModule, InvitesModule, QuotaModule],
  controllers: [
    EventController,
    HouseholdEventsController,
    EventLifecycleController,
    EventAttendeeController,
    EventGameNominationController,
    EventOccurrenceController,
    OfferedGameController,
    LineupController,
    EventPolicyController,
    EventInviteController,
  ],
  providers: [
    EventService,
    EventLifecycleService,
    EventAttendeeService,
    EventGameNominationService,
    EventOccurrenceService,
    EventNotificationListener,
    OfferedGameService,
    LineupService,
    EventPolicyService,
    EventInviteService,
  ],
  exports: [EventService, EventAttendeeService, EventGameNominationService, EventOccurrenceService],
})
export class EventModule {}
