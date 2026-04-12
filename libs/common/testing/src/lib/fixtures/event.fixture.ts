import type {
  Event,
  EventAttendee,
  EventAttendeeGameList,
  EventAttendeeRole,
  EventOccurrence,
  EventPolicy,
} from '@bge/database';
import {
  EventParticipationStatus,
  EventSchedulingMode,
  EventStatus,
  EventType,
  GameAdditionMode,
  InterestedWeight,
  OccurrenceStatus,
  Visibility,
  VoteEligibility,
  VoteQuorumType,
  VoteThresholdType,
} from '@bge/database';
import { sequence } from './sequence.js';

export function makeEventOccurrence(
  overrides: Partial<EventOccurrence> & Required<Pick<EventOccurrence, 'eventId'>>,
): EventOccurrence {
  const n = sequence();
  return {
    id: `occ-${n}`,
    label: null,
    startDate: new Date('2024-06-15T19:00:00Z'),
    endDate: new Date('2024-06-15T23:00:00Z'),
    location: null,
    status: OccurrenceStatus.Confirmed,
    sortOrder: 0,
    confirmedAt: null,
    declinedAt: null,
    cancelledAt: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeEventPolicy(eventId: string, overrides: Partial<EventPolicy> = {}): EventPolicy {
  const n = sequence();
  return {
    id: `policy-${n}`,
    eventId,
    allowMemberInvites: true,
    allowGuestInvites: true,
    maxAttendees: null,
    restrictToGameCategories: false,
    requireHostApprovalToJoin: false,
    allowSpectators: true,
    maxTotalParticipants: null,
    strictCapacity: false,
    gameAdditionMode: GameAdditionMode.Direct,
    restrictToAttendeePool: true,
    fillerMaxPlayTime: null,
    voteThresholdType: VoteThresholdType.SimpleMajority,
    voteThresholdValue: null,
    voteQuorumType: VoteQuorumType.None,
    voteQuorumValue: null,
    voteEligibility: VoteEligibility.ConfirmedOnly,
    interestedWeight: InterestedWeight.AsAbstain,
    votingWindowHours: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeEventAttendee(
  overrides: Partial<EventAttendee> & Required<Pick<EventAttendee, 'eventId'>>,
): EventAttendee {
  const n = sequence();
  return {
    id: `attendee-${n}`,
    userId: `user-${n}`,
    guestName: null,
    guestEmail: null,
    status: EventParticipationStatus.Invited,
    invitedById: null,
    notes: null,
    rsvpDate: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeEventAttendeeRole(
  eventAttendeeId: string,
  roleId: string,
  overrides: Partial<EventAttendeeRole> = {},
): EventAttendeeRole {
  const n = sequence();
  return {
    id: `ear-${n}`,
    eventAttendeeId,
    roleId,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeEventAttendeeGameList(
  attendeeId: string,
  collectionId: string,
  overrides: Partial<EventAttendeeGameList> = {},
): EventAttendeeGameList {
  const n = sequence();
  return {
    id: `eagl-${n}`,
    attendeeId,
    collectionId,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<Event> = {}): Event {
  const n = sequence();
  return {
    id: `event-${n}`,
    title: `Event ${n}`,
    status: EventStatus.Planning,
    createdById: 'user-1',
    image: null,
    householdId: null,
    description: null,
    recurrenceRuleId: null,
    recurrenceStatus: null,
    schedulingMode: EventSchedulingMode.Fixed,
    location: null,
    url: null,
    type: EventType.CasualGathering,
    visibility: Visibility.Friends,
    deletedAt: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
