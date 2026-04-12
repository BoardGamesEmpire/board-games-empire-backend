import { DatabaseModule } from '@bge/database';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { PermissionsModule } from '@bge/permissions';
import { Module } from '@nestjs/common';
import { EventAttendeeController } from './attendee/event-attendee.controller';
import { EventAttendeeService } from './attendee/event-attendee.service';
import { EventController } from './event.controller';
import { EventService } from './event.service';
import { EventNotificationListener } from './listeners/event-notification.listener';
import { EventGameNominationController } from './nomination/event-game-nomination.controller';
import { EventGameNominationService } from './nomination/event-game-nomination.service';
import { EventOccurrenceController } from './occurrence/event-occurrence.controller';
import { EventOccurrenceService } from './occurrence/event-occurrence.service';

@Module({
  imports: [DatabaseModule, PermissionsModule, NotificationsServiceModule],
  controllers: [EventController, EventAttendeeController, EventGameNominationController, EventOccurrenceController],
  providers: [
    EventService,
    EventAttendeeService,
    EventGameNominationService,
    EventOccurrenceService,
    EventNotificationListener,
  ],
  exports: [EventService, EventAttendeeService, EventGameNominationService, EventOccurrenceService],
})
export class EventModule {}
