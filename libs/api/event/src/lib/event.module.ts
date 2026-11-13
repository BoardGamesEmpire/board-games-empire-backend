import { DatabaseModule } from '@bge/database';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { PermissionsModule } from '@bge/permissions';
import { Module } from '@nestjs/common';
import { EventAttendeeController } from './attendee/event-attendee.controller';
import { EventAttendeeService } from './attendee/event-attendee.service';
import { EventController } from './event.controller';
import { EventService } from './event.service';
import { HouseholdEventsController } from './household-events.controller';
import { EventLifecycleController } from './lifecycle/event-lifecycle.controller';
import { EventLifecycleService } from './lifecycle/event-lifecycle.service';
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
  imports: [DatabaseModule, PermissionsModule, NotificationsServiceModule],
  controllers: [
    EventController,
    HouseholdEventsController,
    EventLifecycleController,
    EventAttendeeController,
    EventGameNominationController,
    EventOccurrenceController,
    OfferedGameController,
    EventPolicyController,
  ],
  providers: [
    EventService,
    EventLifecycleService,
    EventAttendeeService,
    EventGameNominationService,
    EventOccurrenceService,
    EventNotificationListener,
    OfferedGameService,
    EventPolicyService,
  ],
  exports: [EventService, EventAttendeeService, EventGameNominationService, EventOccurrenceService],
})
export class EventModule {}
