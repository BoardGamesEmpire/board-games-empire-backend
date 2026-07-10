export enum AttendeeEvents {
  AttendeeAdded = 'event.attendee.added',
  AttendeeRemoved = 'event.attendee.removed',
  AttendeeStatusUpdated = 'event.attendee.status_updated',
  // Distinct names per mutation (not one shared 'game_list_updated'): the
  // audit unattributed-event notifier dedupes on event name, so a shared name
  // would let one path's alert mask a missing-actor bug on the other.
  GameAddedToList = 'event.attendee.game_list.game_added',
  GameRemovedFromList = 'event.attendee.game_list.game_removed',
}
