import {
  EventSchedulingMode,
  GameAdditionMode,
  OccurrenceStatus,
  ResourceType,
  SystemRole,
  VoteThresholdType,
} from '@bge/database';
import { createActors, pollUntil, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { isRecord } from '../support/wire';
import { createEventClient, eventPolicyPath, EVENTS_PATH } from './event-request';
import { eventDetailEnvelope, eventEnvelope, eventPolicyEnvelope, eventReplayEnvelope } from './event-wire';

/**
 * Changing an event's policy over the real routes (#796, #728).
 *
 * The policy changes on its own route, `PATCH /api/events/:eventId/policy`,
 * under `update:event_policy` (the event's hosts) or its household variant
 * (the household's owners and admins). `PATCH /api/events/:id` refuses the
 * policy, and the dates and invitees too, which have routes of their own.
 *
 * The policy route's check judges the action by type alone, so it passes
 * anyone holding the grant on ANY event; the write is bound to this event's
 * policy by the ceiling the service puts on it. Every denial below sits beside
 * a control showing the same actor, or the same request, succeeding where it
 * should, as in `event-write-authorization.spec.ts`.
 *
 * Events are created through `POST /api/events`, so the creator is the host
 * and the policy row is the one the create wrote.
 */
describe("changing an event's policy (#796)", () => {
  const baseUrl = requireBaseUrl(process.env);

  /** The audit listener writes after the response; generous for a loaded CI runner. */
  const AUDIT_ROW_LANDS_MS = 5_000;

  /**
   * The `event` column of a policy change's audit entry. Inlined rather than
   * imported from the event lib: this suite asserts only what the server wrote.
   */
  const POLICY_UPDATED = 'event.policy.updated';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const { createEvent, createdEventId } = createEventClient(baseUrl);

  const updateEvent = (actor: AuthenticatedActor, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).patch(`${EVENTS_PATH}/${eventId}`).set(actor.headers).send(body);

  const updatePolicy = (caller: Caller, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).patch(eventPolicyPath(eventId)).set(caller.headers).send(body);

  const readEvent = async (actor: AuthenticatedActor, eventId: string) =>
    eventDetailEnvelope(
      await request(baseUrl).get(`${EVENTS_PATH}/${eventId}`).set(actor.headers).expect(200),
      'GET /api/events/:id',
    );

  const addAttendee = (actor: AuthenticatedActor, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`${EVENTS_PATH}/${eventId}/attendees`).set(actor.headers).send(body);

  const storedPolicy = (eventId: string) => db.client.eventPolicy.findUniqueOrThrow({ where: { eventId } });

  const policyAuditEntries = (policyId: string) =>
    db.client.auditLog.findMany({
      where: { event: POLICY_UPDATED, subject: ResourceType.EventPolicy, subjectId: policyId },
    });

  /** The policy's audit entries, once one that changed `field` has been written. */
  const auditEntriesOnceOneChanges = (policyId: string, field: string) =>
    pollUntil(
      async () => {
        const entries = await policyAuditEntries(policyId);
        const landed = entries.some(
          ({ payload }) => isRecord(payload) && isRecord(payload['after']) && field in payload['after'],
        );

        return landed ? entries : undefined;
      },
      { description: `the audit entry for a change to ${field} on policy ${policyId}`, timeoutMs: AUDIT_ROW_LANDS_MS },
    );

  describe('PATCH /api/events/:id', () => {
    it('answers 400 to a patch carrying the policy, dates or invitees, and leaves the event as it was', async () => {
      const host = await actors.user();
      const invitee = await actors.user();
      const eventId = await createdEventId(host);

      // Control: the host can PATCH this event.
      await updateEvent(host, eventId, { title: 'Renamed' }).expect(200);

      const snapshot = () =>
        db.client.event.findUniqueOrThrow({
          where: { id: eventId },
          include: { policy: true, occurrences: true, attendees: true },
        });
      const before = await snapshot();

      // Each carries a title beside the refused key, so a patch that dropped
      // the key and applied the rest would show in the snapshot.
      const refusedBodies = [
        { title: 'Not applied', policy: { gameAdditionMode: GameAdditionMode.RequiresVote } },
        { title: 'Not applied', occurrences: [{ label: 'Saturday' }] },
        { title: 'Not applied', inviteUserIds: [invitee.user.id] },
      ];
      for (const body of refusedBodies) {
        expectErrorEnvelope(await updateEvent(host, eventId, body), { status: 400, code: null });
      }

      expect(await snapshot()).toEqual(before);
    });

    it('refuses a switch to Fixed while two dates are Confirmed, and makes it once one is cancelled', async () => {
      const host = await actors.user();
      const created = eventReplayEnvelope(
        await createEvent(host, {
          schedulingMode: EventSchedulingMode.MultiDay,
          occurrences: [{ label: 'Saturday' }, { label: 'Sunday' }],
        }).expect(201),
        'POST /api/events in MultiDay mode with two dates',
      );
      const [saturday, sunday] = created.occurrences;
      expect(created.occurrences.map(({ status }) => status)).toEqual([
        OccurrenceStatus.Confirmed,
        OccurrenceStatus.Confirmed,
      ]);

      expectErrorEnvelope(await updateEvent(host, created.id, { schedulingMode: EventSchedulingMode.Fixed }), {
        status: 400,
        code: 'EVENT_FIXED_MODE_TOO_MANY_DATES',
      });
      expect(
        await db.client.event.findUniqueOrThrow({ where: { id: created.id }, select: { schedulingMode: true } }),
      ).toEqual({ schedulingMode: EventSchedulingMode.MultiDay });

      await request(baseUrl)
        .post(`${EVENTS_PATH}/${created.id}/occurrences/${saturday.id}/cancel`)
        .set(host.headers)
        .expect(201);

      const switched = eventEnvelope(
        await updateEvent(host, created.id, { schedulingMode: EventSchedulingMode.Fixed }).expect(200),
        'PATCH /api/events/:id to Fixed with one date left',
      );
      expect(switched.schedulingMode).toBe(EventSchedulingMode.Fixed);

      // The switch leaves each date's status as it was.
      const dates = await db.client.eventOccurrence.findMany({
        where: { eventId: created.id },
        select: { id: true, status: true },
      });
      expect(dates).toEqual(
        expect.arrayContaining([
          { id: saturday.id, status: OccurrenceStatus.Cancelled },
          { id: sunday.id, status: OccurrenceStatus.Confirmed },
        ]),
      );
      expect(dates).toHaveLength(2);
    });
  });

  describe('PATCH /api/events/:eventId/policy', () => {
    it("lets the host require a vote for games, serves it on the event's read, and records one audit entry", async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host);

      const policy = eventPolicyEnvelope(
        await updatePolicy(host, eventId, { gameAdditionMode: GameAdditionMode.RequiresVote }).expect(200),
        'PATCH /api/events/:eventId/policy as the host',
      );
      expect(policy).toEqual(expect.objectContaining({ eventId, gameAdditionMode: GameAdditionMode.RequiresVote }));

      const read = await readEvent(host, eventId);
      expect(read.policy?.gameAdditionMode).toBe(GameAdditionMode.RequiresVote);

      // The audit entry is written by a listener after the response, so it is
      // awaited with a deadline rather than read at once. It records only the
      // column that changed (#728).
      const policyId = (await storedPolicy(eventId)).id;
      const entries = await auditEntriesOnceOneChanges(policyId, 'gameAdditionMode');
      expect(entries).toHaveLength(1);
      expect(entries[0].payload).toEqual({
        before: { id: policyId, gameAdditionMode: GameAdditionMode.Direct },
        after: { id: policyId, gameAdditionMode: GameAdditionMode.RequiresVote },
      });
    });

    it("refuses an organizer this event's policy, though they host an event of their own and may edit this one", async () => {
      // An organizer holds `update:event` but not `update:event_policy`. This
      // one hosts another event, so they hold the policy grant there, the
      // route's type-level check passes them, and only the binding to this
      // event's policy is left to refuse them.
      const host = await actors.user();
      const organizer = await actors.user();
      const eventId = await createdEventId(host);
      const ownEventId = await createdEventId(organizer);
      await addAttendee(host, eventId, { userId: organizer.user.id, role: SystemRole.EventOrganizer }).expect(201);

      // Control: the organizer changes the policy of the event they host.
      await updatePolicy(organizer, ownEventId, { gameAdditionMode: GameAdditionMode.RequiresVote }).expect(200);

      const before = await storedPolicy(eventId);
      await updatePolicy(organizer, eventId, { gameAdditionMode: GameAdditionMode.RequiresVote }).expect(403);
      expect(await storedPolicy(eventId)).toEqual(before);

      // Control: the same organizer edits the event itself.
      await updateEvent(organizer, eventId, { title: 'Edited by the organizer' }).expect(200);
    });

    it("lets a household's owner change the policy of its event without attending it", async () => {
      const owner = await actors.user();
      const member = await actors.user();
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });
      const eventId = await createdEventId(member, { householdId: household.id });
      expect(await db.client.eventAttendee.count({ where: { eventId, userId: owner.user.id } })).toBe(0);

      const policy = eventPolicyEnvelope(
        await updatePolicy(owner, eventId, { allowSpectators: false }).expect(200),
        "PATCH /api/events/:eventId/policy as the household's owner",
      );
      expect(policy).toEqual(expect.objectContaining({ eventId, allowSpectators: false }));
      expect((await storedPolicy(eventId)).allowSpectators).toBe(false);
    });

    it("refuses another household's owner the policy of this household's event", async () => {
      // Each household's event is created by a member, so neither owner
      // attends either event and the household grant is the only one in play.
      const owner = await actors.user();
      const member = await actors.user();
      const otherOwner = await actors.user();
      const otherMember = await actors.user();
      const { household } = await actors.householdWithMembers({
        owner,
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });
      const { household: otherHousehold } = await actors.householdWithMembers({
        owner: otherOwner,
        members: [{ actor: otherMember, role: SystemRole.HouseholdMember }],
      });
      const eventId = await createdEventId(member, { householdId: household.id });
      const otherEventId = await createdEventId(otherMember, { householdId: otherHousehold.id });

      // Control: the other owner changes the policy of their own household's
      // event, so the refusal after it is the household binding's.
      await updatePolicy(otherOwner, otherEventId, { allowSpectators: false }).expect(200);

      const before = await storedPolicy(eventId);
      await updatePolicy(otherOwner, eventId, { allowSpectators: !before.allowSpectators }).expect(403);
      expect(await storedPolicy(eventId)).toEqual(before);
    });

    it('lets a key that may change the policy but not read it make the change, and answers it a null policy', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host);
      const key = await mintApiKey(baseUrl, db.client, host, {
        slugs: ['update:event_policy'],
        resourceType: ResourceType.EventPolicy,
      });

      const policy = eventPolicyEnvelope(
        await updatePolicy(key, eventId, { gameAdditionMode: GameAdditionMode.RequiresVote }).expect(200),
        'PATCH /api/events/:eventId/policy with a key that may not read the policy',
      );
      expect(policy).toBeNull();

      // Control: the change landed, and the key's owner reads it, so the null
      // is the key's missing read and not a policy nobody can see.
      const read = await readEvent(host, eventId);
      expect(read.policy).toEqual(
        expect.objectContaining({ eventId, gameAdditionMode: GameAdditionMode.RequiresVote }),
      );
    });

    it('answers 400 EVENT_POLICY_INVALID to a Supermajority threshold with no value, and writes nothing', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host);
      const before = await storedPolicy(eventId);
      expect(before.voteThresholdValue).toBeNull();

      expectErrorEnvelope(await updatePolicy(host, eventId, { voteThresholdType: VoteThresholdType.Supermajority }), {
        status: 400,
        code: 'EVENT_POLICY_INVALID',
      });
      expect(await storedPolicy(eventId)).toEqual(before);

      // Control: the same threshold with its value.
      await updatePolicy(host, eventId, {
        voteThresholdType: VoteThresholdType.Supermajority,
        voteThresholdValue: 66,
      }).expect(200);
    });

    it('answers a patch that re-sends the stored game addition mode 200, and records no audit entry for it', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host);
      const stored = await storedPolicy(eventId);

      await updatePolicy(host, eventId, { gameAdditionMode: stored.gameAdditionMode }).expect(200);

      // An absence is only worth asserting once this harness is shown to
      // record a change at all, so a real change runs after the re-send and
      // its entry is polled for. The listener writes each entry after the
      // response, so the check relies on entries landing in the order their
      // changes were emitted: an entry from the re-send would land before the
      // real change's, and be in the list the poll returns (#728).
      await updatePolicy(host, eventId, { allowSpectators: !stored.allowSpectators }).expect(200);

      const entries = await auditEntriesOnceOneChanges(stored.id, 'allowSpectators');
      expect(entries).toHaveLength(1);
      expect(entries[0].payload).toEqual({
        before: { id: stored.id, allowSpectators: stored.allowSpectators },
        after: { id: stored.id, allowSpectators: !stored.allowSpectators },
      });
    });

    it('answers 404 for a deleted event, and leaves its policy as it was', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host);

      // Control: the host changes the policy while the event is live.
      await updatePolicy(host, eventId, { allowSpectators: false }).expect(200);

      await request(baseUrl).delete(`${EVENTS_PATH}/${eventId}`).set(host.headers).expect(200);

      await updatePolicy(host, eventId, { allowSpectators: true }).expect(404);
      expect((await storedPolicy(eventId)).allowSpectators).toBe(false);
    });
  });
});
