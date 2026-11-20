import { Auditable } from '@bge/actor-context';
import { HouseholdMembershipOrigin, MemberInvitePolicy, MemberSharePolicy, Reach, ResourceType } from '@bge/database';
import { Reflector } from '@nestjs/core';
import { HouseholdEvents } from '../constants/household-events.constant';
import type { HouseholdBanSnapshot, HouseholdMembershipSnapshot, HouseholdStateRow } from './household.events';
import {
  HouseholdBanCreatedEvent,
  HouseholdBanLiftedEvent,
  HouseholdBanUpdatedEvent,
  HouseholdCreatedEvent,
  HouseholdDeletedEvent,
  HouseholdMemberAdmittedEvent,
  HouseholdMemberRemovedEvent,
  HouseholdMemberRoleChangedEvent,
  HouseholdRestoredEvent,
  householdStateSnapshot,
  HouseholdUpdatedEvent,
  MembershipEndCause,
} from './household.events';

const INITIATED_AT = new Date('2026-11-19T12:00:00Z');
const DELETED_AT = new Date('2026-11-18T09:30:00Z');

const membership = (overrides: Partial<HouseholdMembershipSnapshot> = {}): HouseholdMembershipSnapshot => ({
  householdId: 'hh-1',
  userId: 'user-1',
  memberId: 'member-1',
  role: 'HouseholdMember',
  ...overrides,
});

const ban = (overrides: Partial<HouseholdBanSnapshot> = {}): HouseholdBanSnapshot => ({
  householdId: 'hh-1',
  userId: 'user-1',
  banId: 'ban-1',
  reason: 'Kept cancelling game night',
  ...overrides,
});

/** Each household change's domain event class and the name it is emitted under (#245). */
const NAMED_CLASSES = [
  [HouseholdCreatedEvent, HouseholdEvents.Created],
  [HouseholdUpdatedEvent, HouseholdEvents.Updated],
  [HouseholdDeletedEvent, HouseholdEvents.Deleted],
  [HouseholdRestoredEvent, HouseholdEvents.Restored],
  [HouseholdMemberAdmittedEvent, HouseholdEvents.MemberAdmitted],
  [HouseholdMemberRoleChangedEvent, HouseholdEvents.MemberRoleChanged],
  [HouseholdMemberRemovedEvent, HouseholdEvents.MemberRemoved],
  [HouseholdBanCreatedEvent, HouseholdEvents.BanCreated],
  [HouseholdBanUpdatedEvent, HouseholdEvents.BanUpdated],
  [HouseholdBanLiftedEvent, HouseholdEvents.BanLifted],
] as const;

describe('household domain events (#245)', () => {
  describe("every household change's domain event", () => {
    const reflector = new Reflector();

    it.each(NAMED_CLASSES.map(([cls, name]) => [cls.name, name, cls] as const))(
      '%s is emitted as %s and is audited by default',
      (_label, name, cls) => {
        expect(cls.eventName).toBe(name);
        // Audited by default: an opt-out on one of these would leave a
        // household change with no audit entry, which is what #245 closes.
        expect(reflector.get(Auditable, cls)).not.toBe(false);
      },
    );
  });

  describe('HouseholdCreatedEvent', () => {
    it('is a create of the household, keyed by its id', () => {
      const after = {
        id: 'hh-1',
        name: 'The Meeple House',
        description: null,
        image: null,
        reach: Reach.Private,
        languageTagId: null,
      };

      const event = new HouseholdCreatedEvent(after, INITIATED_AT);

      expect(event).toMatchObject({ subject: ResourceType.Household, subjectId: 'hh-1', action: 'create' });
      expect(event.before).toBeNull();
      expect(event.after).toBe(after);
      expect(event.initiatedAt).toBe(INITIATED_AT);
    });
  });

  describe('HouseholdUpdatedEvent', () => {
    it('is an update of the household carrying the changed columns on each side', () => {
      const event = new HouseholdUpdatedEvent(
        { id: 'hh-1', name: 'Old name', memberSharePolicy: MemberSharePolicy.Off },
        { id: 'hh-1', name: 'New name', memberSharePolicy: MemberSharePolicy.Direct },
        INITIATED_AT,
      );

      expect(event).toMatchObject({ subject: ResourceType.Household, subjectId: 'hh-1', action: 'update' });
      expect(event.before).toEqual({ id: 'hh-1', name: 'Old name', memberSharePolicy: MemberSharePolicy.Off });
      expect(event.after).toEqual({ id: 'hh-1', name: 'New name', memberSharePolicy: MemberSharePolicy.Direct });
    });
  });

  describe('HouseholdDeletedEvent', () => {
    // A soft delete modeled as a domain delete, as `EventDeletedEvent` is.
    it('is a delete of the household, recording who was given a restore window', () => {
      const before = { id: 'hh-1', name: 'The Meeple House', restoreWindowUserIds: ['user-1', 'user-2'] };

      const event = new HouseholdDeletedEvent(before, INITIATED_AT);

      expect(event).toMatchObject({ subject: ResourceType.Household, subjectId: 'hh-1', action: 'delete' });
      expect(event.before).toBe(before);
      expect(event.after).toBeNull();
    });
  });

  describe('HouseholdRestoredEvent', () => {
    it('is an update of the household, its deletedAt going from set to null', () => {
      const event = new HouseholdRestoredEvent(
        { id: 'hh-1', deletedAt: DELETED_AT, restoreWindowUserIds: ['user-1'] },
        { id: 'hh-1', deletedAt: null, restoreWindowUserIds: [] },
        INITIATED_AT,
      );

      expect(event).toMatchObject({ subject: ResourceType.Household, subjectId: 'hh-1', action: 'update' });
      expect(event.before).toEqual({ id: 'hh-1', deletedAt: DELETED_AT, restoreWindowUserIds: ['user-1'] });
      expect(event.after).toEqual({ id: 'hh-1', deletedAt: null, restoreWindowUserIds: [] });
    });
  });

  // A membership, a role change and a ban each change the household, which is
  // the subject; so each is an update of it, never a create or a delete.
  describe('HouseholdMemberAdmittedEvent', () => {
    it('is an update of the household, building a before with no membership for the same user', () => {
      const after = membership({ origin: HouseholdMembershipOrigin.InviteAccepted });

      const event = new HouseholdMemberAdmittedEvent(after, INITIATED_AT);

      expect(event).toMatchObject({ subject: ResourceType.Household, subjectId: 'hh-1', action: 'update' });
      expect(event.before).toEqual({ householdId: 'hh-1', userId: 'user-1', memberId: null, role: null });
      expect(event.after).toBe(after);
    });
  });

  describe('HouseholdMemberRoleChangedEvent', () => {
    it('is an update of the household, with the role before and after', () => {
      const before = membership({ role: 'HouseholdMember' });
      const after = membership({ role: 'HouseholdAdmin' });

      const event = new HouseholdMemberRoleChangedEvent(before, after, INITIATED_AT);

      expect(event).toMatchObject({ subject: ResourceType.Household, subjectId: 'hh-1', action: 'update' });
      expect(event.before).toBe(before);
      expect(event.after).toBe(after);
    });
  });

  describe('HouseholdMemberRemovedEvent', () => {
    it.each(Object.values(MembershipEndCause))(
      'is an update of the household, building an after with no membership and the cause %s',
      (cause) => {
        const before = membership();

        const event = new HouseholdMemberRemovedEvent(before, cause, INITIATED_AT);

        expect(event).toMatchObject({ subject: ResourceType.Household, subjectId: 'hh-1', action: 'update' });
        expect(event.before).toBe(before);
        expect(event.after).toEqual({ householdId: 'hh-1', userId: 'user-1', memberId: null, role: null, cause });
      },
    );

    it('records a ban as the cause by its value', () => {
      const event = new HouseholdMemberRemovedEvent(membership(), MembershipEndCause.Banned, INITIATED_AT);

      expect(event.after).toEqual({
        householdId: 'hh-1',
        userId: 'user-1',
        memberId: null,
        role: null,
        cause: 'banned',
      });
    });
  });

  describe('HouseholdBanCreatedEvent', () => {
    it('is an update of the household, building a before with no ban for the same user', () => {
      const after = ban();

      const event = new HouseholdBanCreatedEvent(after, INITIATED_AT);

      expect(event).toMatchObject({ subject: ResourceType.Household, subjectId: 'hh-1', action: 'update' });
      expect(event.before).toEqual({ householdId: 'hh-1', userId: 'user-1', banId: null, reason: null });
      expect(event.after).toBe(after);
    });
  });

  describe('HouseholdBanUpdatedEvent', () => {
    it('is an update of the household, with the reason before and after', () => {
      const before = ban({ reason: 'First reason' });
      const after = ban({ reason: 'Second reason' });

      const event = new HouseholdBanUpdatedEvent(before, after, INITIATED_AT);

      expect(event).toMatchObject({ subject: ResourceType.Household, subjectId: 'hh-1', action: 'update' });
      expect(event.before).toBe(before);
      expect(event.after).toBe(after);
    });
  });

  describe('HouseholdBanLiftedEvent', () => {
    it('is an update of the household, building an after with no ban for the same user', () => {
      const before = ban();

      const event = new HouseholdBanLiftedEvent(before, INITIATED_AT);

      expect(event).toMatchObject({ subject: ResourceType.Household, subjectId: 'hh-1', action: 'update' });
      expect(event.before).toBe(before);
      expect(event.after).toEqual({ householdId: 'hh-1', userId: 'user-1', banId: null, reason: null });
    });
  });

  describe('householdStateSnapshot', () => {
    const row: HouseholdStateRow = {
      id: 'hh-1',
      name: 'The Meeple House',
      description: 'Board games on Fridays',
      image: 'https://images.example.test/hh-1.png',
      reach: Reach.Friends,
      languageTagId: 'lang-en',
      settings: {
        memberInvitePolicy: MemberInvitePolicy.Direct,
        memberSharePolicy: MemberSharePolicy.NeedsApproval,
      },
    };

    it('flattens the household columns and its settings into one snapshot, so one diff covers both', () => {
      expect(householdStateSnapshot(row)).toEqual({
        id: 'hh-1',
        name: 'The Meeple House',
        description: 'Board games on Fridays',
        image: 'https://images.example.test/hh-1.png',
        reach: Reach.Friends,
        languageTagId: 'lang-en',
        memberInvitePolicy: MemberInvitePolicy.Direct,
        memberSharePolicy: MemberSharePolicy.NeedsApproval,
      });
    });

    it('carries no other column of a wider row', () => {
      const wider = {
        ...row,
        createdById: 'user-1',
        clientRequestId: 'client-request-1',
        deletedAt: null,
        createdAt: INITIATED_AT,
        updatedAt: INITIATED_AT,
      };

      expect(Object.keys(householdStateSnapshot(wider)).sort()).toEqual([
        'description',
        'id',
        'image',
        'languageTagId',
        'memberInvitePolicy',
        'memberSharePolicy',
        'name',
        'reach',
      ]);
    });

    it('reads each setting as null for a household with no settings row', () => {
      const snapshot = householdStateSnapshot({ ...row, settings: null });

      expect(snapshot.memberInvitePolicy).toBeNull();
      expect(snapshot.memberSharePolicy).toBeNull();
      expect(snapshot.name).toBe('The Meeple House');
    });
  });
});
