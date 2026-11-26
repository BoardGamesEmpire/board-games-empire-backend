import { Action, ResourceType, SystemRole } from '@bge/database';
import { CodedHttpException } from '@bge/i18n';
import type { AbilityService, UserAbilityCheck } from '@bge/permissions';
import type { MockDatabaseService } from '@bge/testing';
import { createMockDatabaseService } from '@bge/testing';
import { ForbiddenException } from '@nestjs/common';
import type { AssignableAttendeeRole } from '../attendee/dto/add-attendee.dto';
import type { EventInviteAuthority, EventRosterRow } from './event-invite-authority';
import {
  assertMayInvite,
  eventAttendeeSubject,
  eventInviteSubject,
  readEventInviteAuthority,
  senderCouldStillSend,
} from './event-invite-authority';

const rosterRow = (userId: string, name: SystemRole): EventRosterRow => ({ userId, role: { role: { name } } });

const HOST = rosterRow('host-1', SystemRole.EventHost);
const ORGANIZER = rosterRow('organizer-1', SystemRole.EventOrganizer);
const PARTICIPANT = rosterRow('participant-1', SystemRole.EventParticipant);

const authority = (allowMemberInvites: boolean): EventInviteAuthority => ({
  eventId: 'ev-1',
  householdId: 'hh-1',
  allowMemberInvites,
  attendees: [HOST, ORGANIZER, PARTICIPANT],
});

describe('event invite authority (#742)', () => {
  describe('readEventInviteAuthority', () => {
    let db: MockDatabaseService;

    beforeEach(() => {
      db = createMockDatabaseService();
    });

    it('reads the household, the event policy’s switch and the live roster in one query', async () => {
      db.event.findUnique.mockResolvedValue({
        householdId: 'hh-1',
        policy: { allowMemberInvites: false },
        attendees: [HOST],
      } as never);

      await expect(readEventInviteAuthority(db as never, 'ev-1')).resolves.toEqual({
        eventId: 'ev-1',
        householdId: 'hh-1',
        allowMemberInvites: false,
        attendees: [HOST],
      });
      expect(db.event.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'ev-1' } }));
    });

    it('reads an event with no policy row as letting attendees invite, the schema’s default', async () => {
      db.event.findUnique.mockResolvedValue({ householdId: null, policy: null, attendees: [] } as never);

      await expect(readEventInviteAuthority(db as never, 'ev-1')).resolves.toMatchObject({
        allowMemberInvites: true,
      });
    });

    it('reads a missing event as an empty roster outside any household', async () => {
      db.event.findUnique.mockResolvedValue(null);

      await expect(readEventInviteAuthority(db as never, 'ev-1')).resolves.toEqual({
        eventId: 'ev-1',
        householdId: null,
        allowMemberInvites: true,
        attendees: [],
      });
    });
  });

  describe('eventInviteSubject', () => {
    it('carries the whole roster while the event policy lets attendees invite', () => {
      expect(eventInviteSubject(authority(true))).toEqual({
        eventId: 'ev-1',
        event: { householdId: 'hh-1', attendees: [HOST, ORGANIZER, PARTICIPANT] },
      });
    });

    it('leaves the participant rows out while allowMemberInvites is off, and every other row in', () => {
      expect(eventInviteSubject(authority(false)).event.attendees).toEqual([HOST, ORGANIZER]);
    });
  });

  describe('assertMayInvite', () => {
    type Subject = ReturnType<typeof eventInviteSubject>;
    const hasParticipant = (instance: unknown) => (instance as Subject).event.attendees.includes(PARTICIPANT);

    let abilities: jest.Mocked<Pick<AbilityService, 'assertCurrentActorCan' | 'currentActorCan'>>;

    beforeEach(() => {
      abilities = { assertCurrentActorCan: jest.fn(), currentActorCan: jest.fn().mockReturnValue(true) };
    });

    const assertAs = (current: EventInviteAuthority, role: AssignableAttendeeRole) =>
      assertMayInvite(abilities as unknown as AbilityService, current, role);

    it('asks the whole roster first, whatever the event policy says', () => {
      assertAs(authority(false), SystemRole.EventParticipant);

      const [action, type, instance] = abilities.assertCurrentActorCan.mock.calls[0];

      expect([action, type]).toEqual([Action.create, ResourceType.Invite]);
      expect((instance as Subject).event.attendees).toEqual([HOST, ORGANIZER, PARTICIPANT]);
      expect(hasParticipant(instance)).toBe(true);
    });

    it('asks the direct add’s grant too for any role but participant', () => {
      assertAs(authority(true), SystemRole.EventCoHost);

      expect(abilities.assertCurrentActorCan).toHaveBeenCalledWith(
        Action.create,
        ResourceType.EventAttendee,
        eventAttendeeSubject(authority(true), SystemRole.EventCoHost),
      );
    });

    it('answers MEMBER_INVITES_OFF when only the roster under the policy refuses', () => {
      abilities.currentActorCan.mockImplementation((_action, _type, instance) => hasParticipant(instance));

      expect(() => assertAs(authority(true), SystemRole.EventParticipant)).not.toThrow();
      expect(() => assertAs(authority(false), SystemRole.EventParticipant)).toThrow(CodedHttpException);
    });

    it('lets the whole-roster denial through as the usual 403', () => {
      abilities.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      expect(() => assertAs(authority(false), SystemRole.EventParticipant)).toThrow(ForbiddenException);
      expect(abilities.currentActorCan).not.toHaveBeenCalled();
    });
  });

  describe('senderCouldStillSend', () => {
    let senderCan: jest.Mock<boolean, Parameters<UserAbilityCheck>>;
    let abilities: jest.Mocked<Pick<AbilityService, 'userAbilityWithin'>>;
    const tx = {} as never;

    beforeEach(() => {
      senderCan = jest.fn().mockReturnValue(true);
      abilities = { userAbilityWithin: jest.fn().mockResolvedValue(senderCan) };
    });

    const ask = (current: EventInviteAuthority, role: AssignableAttendeeRole) =>
      senderCouldStillSend(abilities as unknown as AbilityService, tx, current, { inviterId: 'participant-1', role });

    it('asks the sender’s own ability, as the transaction reads it, about the roster under the policy', async () => {
      await expect(ask(authority(false), SystemRole.EventParticipant)).resolves.toBe(true);

      expect(abilities.userAbilityWithin).toHaveBeenCalledWith(tx, 'participant-1');
      expect(senderCan).toHaveBeenCalledWith(Action.create, ResourceType.Invite, eventInviteSubject(authority(false)));
      expect(senderCan).toHaveBeenCalledTimes(1);
    });

    it('refuses a participant’s invite once allowMemberInvites is off', async () => {
      senderCan.mockImplementation((_action, _type, instance) =>
        (instance as ReturnType<typeof eventInviteSubject>).event.attendees.some((row) => row === PARTICIPANT),
      );

      await expect(ask(authority(true), SystemRole.EventParticipant)).resolves.toBe(true);
      await expect(ask(authority(false), SystemRole.EventParticipant)).resolves.toBe(false);
    });

    it('also asks the direct add’s grant for any role but participant', async () => {
      senderCan.mockImplementation((_action, type) => type !== ResourceType.EventAttendee);

      await expect(ask(authority(true), SystemRole.EventCoHost)).resolves.toBe(false);

      expect(senderCan).toHaveBeenCalledWith(
        Action.create,
        ResourceType.EventAttendee,
        eventAttendeeSubject(authority(true), SystemRole.EventCoHost),
      );
    });
  });
});
