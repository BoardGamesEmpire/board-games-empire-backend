import { AuditExclude, Auditable } from '@bge/actor-context';
import { InviteStatus, InviteType, ResourceType } from '@bge/database';
import { Reflector } from '@nestjs/core';
import { InviteEvents } from '../constants/invite-events.constant';
import {
  INVITE_SNAPSHOT_FIELDS,
  InviteAcceptedEvent,
  InviteApprovedEvent,
  InviteCreatedEvent,
  InviteDeclinedEvent,
  InviteExpiredEvent,
  InviteRevokedEvent,
  InviteWithdrawnEvent,
  toInviteSnapshot,
  type InviteSnapshot,
} from './invite.events';

const INITIATED_AT = new Date('2026-10-12T12:00:00Z');

/** Every concrete domain event class, for the properties all of them share. */
const EVENT_CLASSES = [
  InviteCreatedEvent,
  InviteAcceptedEvent,
  InviteDeclinedEvent,
  InviteWithdrawnEvent,
  InviteRevokedEvent,
  InviteApprovedEvent,
  InviteExpiredEvent,
] as const;

const snapshot = (overrides: Partial<InviteSnapshot> = {}): InviteSnapshot => ({
  id: 'inv-1',
  type: InviteType.Household,
  status: InviteStatus.Pending,
  inviterId: 'user-inviter',
  inviteeId: 'user-invitee',
  inviteeName: 'Sam',
  inviteeEmail: 'sam@example.test',
  householdId: 'hh-1',
  eventId: null,
  roleId: 'role-member',
  expiresAt: new Date('2026-10-19T12:00:00Z'),
  respondedAt: null,
  ...overrides,
});

describe('invite domain events', () => {
  const reflector = new Reflector();

  describe('every event class', () => {
    it.each(EVENT_CLASSES.map((cls) => [cls.name, cls] as const))(
      '%s is audited by default and strips the invitee email from audit rows',
      (_name, cls) => {
        // Audited by default: a forgotten `@Auditable(false)` fails toward an
        // extra audit row, never a gap. Asserted explicitly so a future opt-out
        // on one of these is a decision rather than a drift.
        expect(reflector.get(Auditable, cls)).not.toBe(false);

        // The address reaches in-process listeners (a notification to someone
        // who is not a registered user needs it) and never a persisted audit row.
        expect(reflector.get(AuditExclude, cls)).toEqual(['inviteeEmail']);
      },
    );

    it('names each one by its lifecycle outcome', () => {
      const names = EVENT_CLASSES.map((cls) => cls.eventName).sort();

      expect(names).toEqual(Object.values(InviteEvents).sort());
    });
  });

  describe('InviteCreatedEvent', () => {
    it('is a create of the Invite subject, keyed by the new row id', () => {
      const event = new InviteCreatedEvent(snapshot(), INITIATED_AT);

      expect(event.action).toBe('create');
      expect(event.subject).toBe(ResourceType.Invite);
      expect(event.subjectId).toBe('inv-1');
      expect(event.before).toBeNull();
      expect(event.after.status).toBe(InviteStatus.Pending);
      expect(event.eventName).toBe(InviteEvents.Created);
      expect(event.initiatedAt).toBe(INITIATED_AT);
    });
  });

  describe('transition events', () => {
    it('are updates carrying the status the row actually left', () => {
      const before = snapshot({ status: InviteStatus.AwaitingApproval });
      const after = snapshot({ status: InviteStatus.Accepted, respondedAt: INITIATED_AT });

      const event = new InviteAcceptedEvent(before, after, INITIATED_AT);

      expect(event.action).toBe('update');
      expect(event.subjectId).toBe('inv-1');
      expect(event.before.status).toBe(InviteStatus.AwaitingApproval);
      expect(event.after.status).toBe(InviteStatus.Accepted);
      expect(event.eventName).toBe(InviteEvents.Accepted);
    });
  });

  describe('toInviteSnapshot', () => {
    it('carries exactly the party and context fields and never the token', () => {
      // A row read for a transition carries more than the snapshot. The
      // projection must take its twelve fields and leave the rest, `token`
      // above all: this is the acceptance criterion "no event payload carries
      // a token", pinned at the one place every payload is built.
      const row = {
        ...snapshot(),
        token: 'live-accept-credential',
        message: 'come play',
        metadata: { source: 'test' },
        needsApproval: false,
        approvedById: null,
        approvedAt: null,
        createdAt: INITIATED_AT,
        updatedAt: INITIATED_AT,
      };

      const projected = toInviteSnapshot(row);

      expect(Object.keys(projected).sort()).toEqual([...INVITE_SNAPSHOT_FIELDS].sort());
      expect(projected).toEqual(snapshot());
      expect(projected).not.toHaveProperty('token');
      expect(JSON.stringify(projected)).not.toContain('live-accept-credential');
    });

    it('lists every snapshot field, so the projection cannot drop one silently', () => {
      // The compiler holds this literal to every key of the interface; the
      // assertion holds the list to the literal. Together they make the list
      // complete, which `satisfies` alone cannot.
      const declared: Record<keyof InviteSnapshot, true> = {
        id: true,
        type: true,
        status: true,
        inviterId: true,
        inviteeId: true,
        inviteeName: true,
        inviteeEmail: true,
        householdId: true,
        eventId: true,
        roleId: true,
        expiresAt: true,
        respondedAt: true,
      };

      expect([...INVITE_SNAPSHOT_FIELDS].sort()).toEqual(Object.keys(declared).sort());
    });
  });
});
