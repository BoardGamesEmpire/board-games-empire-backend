import type { EventParticipationStatus } from '@bge/database';

export interface AttendeeAddedEvent {
  eventId: string;
  attendeeId: string;
  userId: string | null;
  guestName?: string | null;
  role: string;
  addedById: string;
}

export interface AttendeeRemovedEvent {
  eventId: string;
  attendeeId: string;
  userId: string | null;
  removedById: string;
}

export interface AttendeeStatusUpdatedEvent {
  eventId: string;
  attendeeId: string;
  userId: string | null;
  previousStatus: EventParticipationStatus;
  newStatus: EventParticipationStatus;
}

export interface GameListUpdatedEvent {
  eventId: string;
  attendeeId: string;
  userId: string | null;
  action: 'added' | 'removed';
  collectionId: string;
}
