export interface EventCreatedEvent {
  eventId: string;
  createdById: string;
  householdId: string | null;
  invitedUserIds: string[];
  title: string;
}

export interface EventUpdatedEvent {
  eventId: string;
  updatedById: string;
}

export interface EventDeletedEvent {
  eventId: string;
  deletedById: string;
}
