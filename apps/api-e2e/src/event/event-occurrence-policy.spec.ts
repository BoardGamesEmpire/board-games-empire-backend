import {
  EventSchedulingMode,
  GameAdditionMode,
  NominationStatus,
  OccurrenceOverrideScope,
  PlatformType,
  ResourceType,
  SystemRole,
} from '@bge/database';
import { createActors, pollUntil, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import { tabletopPlatform } from '../support/seeded-platforms';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { isRecord } from '../support/wire';
import { arrangeListEntry } from './event-fixtures';
import { createEventClient, eventPolicyPath, EVENTS_PATH, occurrencePolicyPath } from './event-request';
import {
  eventDetailEnvelope,
  eventPolicyEnvelope,
  eventReplayEnvelope,
  nominationEnvelope,
  occurrenceEnvelope,
  occurrencePolicyEnvelope,
  type OccurrencePolicyWire,
} from './event-wire';

/**
 * A date's own policy, and the allowed lists, over the real routes (#796,
 * #1211, #1268).
 *
 * A date's policy changes on
 * `PATCH /api/events/:eventId/occurrences/:occurrenceId/policy`, under the
 * event policy's grant, `update:event_policy`, so an organizer who may edit
 * the date may not set its policy. Each field holds only what the date sets
 * itself: `null` or an empty list is the event's. `GET /api/events/:id` serves
 * each date's own policy beside the event's, and the occurrence routes serve
 * it as the date's `policy`, both under the event policy's read ceiling.
 *
 * The allowed platform types, platforms and categories are set on create, on
 * the event's policy route and on a date's (#1268). How far a date may
 * override them, and capacity, is the event's occurrence override scope: under
 * the default Any a date may lift one, under TightenOnly it may only narrow
 * them, and a switch that would leave a date past the scope is refused, naming
 * the date.
 *
 * Events are created through `POST /api/events`, so the creator is the host.
 * A create writes an empty policy row for each date it makes; a date added on
 * its own route has none until its first change.
 */
describe("a date's own policy and the allowed lists (#796)", () => {
  const baseUrl = requireBaseUrl(process.env);

  /** The audit listener writes after the response; generous for a loaded CI runner. */
  const AUDIT_ROW_LANDS_MS = 5_000;

  /**
   * The `event` column of a date policy change's audit entry. Inlined rather
   * than imported from the event lib: this suite asserts only what the server
   * wrote.
   */
  const OCCURRENCE_POLICY_UPDATED = 'event.occurrence.policy.updated';

  /** The keys that name a date's policy row rather than set anything for the date. */
  const ROW_IDENTITY = new Set(['id', 'occurrenceId', 'createdAt', 'updatedAt']);

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

  /**
   * The event `host` creates, with `policy` when one is given, and the ids of
   * its dates, one per label. Several dates take MultiDay mode, since a Fixed
   * event holds one.
   */
  const createdWithDates = async (
    host: AuthenticatedActor,
    policy?: Record<string, unknown>,
    labels: readonly string[] = ['Saturday'],
  ) => {
    const created = eventReplayEnvelope(
      await createEvent(host, {
        ...(labels.length > 1 ? { schedulingMode: EventSchedulingMode.MultiDay } : {}),
        ...(policy ? { policy } : {}),
        occurrences: labels.map((label) => ({ label })),
      }).expect(201),
      'POST /api/events with dates',
    );

    return { eventId: created.id, dateIds: created.occurrences.map(({ id }) => id) };
  };

  /** The id of a date `host` adds to the event on the occurrence route, which writes it no policy row. */
  const addedDateId = async (host: AuthenticatedActor, eventId: string) =>
    occurrenceEnvelope(
      await request(baseUrl)
        .post(`${EVENTS_PATH}/${eventId}/occurrences`)
        .set(host.headers)
        .send({ label: 'Saturday' })
        .expect(201),
      'POST /api/events/:eventId/occurrences',
    ).id;

  const updatePolicy = (caller: Caller, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).patch(eventPolicyPath(eventId)).set(caller.headers).send(body);

  const updateDatePolicy = (caller: Caller, eventId: string, dateId: string, body: Record<string, unknown>) =>
    request(baseUrl).patch(occurrencePolicyPath(eventId, dateId)).set(caller.headers).send(body);

  const readEvent = async (caller: Caller, eventId: string) =>
    eventDetailEnvelope(
      await request(baseUrl).get(`${EVENTS_PATH}/${eventId}`).set(caller.headers).expect(200),
      'GET /api/events/:id',
    );

  const readDate = async (caller: Caller, eventId: string, dateId: string) =>
    occurrenceEnvelope(
      await request(baseUrl).get(`${EVENTS_PATH}/${eventId}/occurrences/${dateId}`).set(caller.headers).expect(200),
      'GET /api/events/:eventId/occurrences/:occurrenceId',
    );

  const addAttendee = (actor: AuthenticatedActor, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`${EVENTS_PATH}/${eventId}/attendees`).set(actor.headers).send(body);

  const nominate = (actor: AuthenticatedActor, eventId: string, body: Record<string, unknown>) =>
    request(baseUrl).post(`${EVENTS_PATH}/${eventId}/nominations`).set(actor.headers).send(body);

  /** The date's policy row as stored, with its platform type rows, or `null` before its first write. */
  const storedDatePolicy = (occurrenceId: string) =>
    db.client.eventOccurrencePolicy.findUnique({
      where: { occurrenceId },
      include: { allowedPlatformTypes: { orderBy: { platformType: 'asc' } } },
    });

  /** What a served date's policy sets for the date: each field that isn't `null`, an empty list or an unset flag. */
  const fieldsSet = (policy: OccurrencePolicyWire) =>
    Object.fromEntries(
      Object.entries(policy).filter(
        ([key, value]) =>
          !ROW_IDENTITY.has(key) && value !== null && value !== false && !(Array.isArray(value) && value.length === 0),
      ),
    );

  /** The date's policy audit entries, oldest first, once one that changed `field` has been written. */
  const auditEntriesOnceOneChanges = (occurrenceId: string, field: string) =>
    pollUntil(
      async () => {
        const entries = await db.client.auditLog.findMany({
          where: { event: OCCURRENCE_POLICY_UPDATED, subject: ResourceType.EventOccurrence, subjectId: occurrenceId },
          orderBy: { occurredAt: 'asc' },
        });
        const landed = entries.some(
          ({ payload }) => isRecord(payload) && isRecord(payload['after']) && field in payload['after'],
        );

        return landed ? entries : undefined;
      },
      {
        description: `the audit entry for a change to ${field} on date ${occurrenceId}'s policy`,
        timeoutMs: AUDIT_ROW_LANDS_MS,
      },
    );

  describe("the event's allowed lists (#1268)", () => {
    it('serves the platform types a create allows, and the Any override scope a create that names none takes', async () => {
      const host = await actors.user();
      const created = eventReplayEnvelope(
        await createEvent(host, { policy: { allowedPlatformTypes: [PlatformType.Tabletop] } }).expect(201),
        'POST /api/events with allowed platform types',
      );
      expect(created.policy).toEqual(expect.objectContaining({ allowedPlatformTypes: [PlatformType.Tabletop] }));

      // The create named no scope, so Any is the column's default, which only
      // a real database applies (#796).
      const read = await readEvent(host, created.id);
      expect(read.policy).toEqual(
        expect.objectContaining({
          allowedPlatformTypes: [PlatformType.Tabletop],
          allowedPlatformIds: [],
          allowedCategoryIds: [],
          occurrenceOverrideScope: OccurrenceOverrideScope.Any,
        }),
      );
    });

    it("lets the host set the event's allowed platforms, and clear them with an empty list, leaving the platform types as they were", async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host, { policy: { allowedPlatformTypes: [PlatformType.Tabletop] } });
      const tabletop = await tabletopPlatform(db.client);

      const set = eventPolicyEnvelope(
        await updatePolicy(host, eventId, { allowedPlatformIds: [tabletop.id] }).expect(200),
        'PATCH /api/events/:eventId/policy setting the allowed platforms',
      );
      expect(set).toEqual(
        expect.objectContaining({ allowedPlatformIds: [tabletop.id], allowedPlatformTypes: [PlatformType.Tabletop] }),
      );
      expect((await readEvent(host, eventId)).policy).toEqual(
        expect.objectContaining({ allowedPlatformIds: [tabletop.id], allowedPlatformTypes: [PlatformType.Tabletop] }),
      );

      await updatePolicy(host, eventId, { allowedPlatformIds: [] }).expect(200);

      expect((await readEvent(host, eventId)).policy).toEqual(
        expect.objectContaining({ allowedPlatformIds: [], allowedPlatformTypes: [PlatformType.Tabletop] }),
      );
    });

    it('answers 400 EVENT_POLICY_UNKNOWN_REFERENCE to a platform id that names none, and writes nothing', async () => {
      const host = await actors.user();
      const eventId = await createdEventId(host);
      const tabletop = await tabletopPlatform(db.client);

      // Sent beside a platform that exists, so a write that dropped the
      // unknown id and kept the rest would show.
      expectErrorEnvelope(await updatePolicy(host, eventId, { allowedPlatformIds: [tabletop.id, randomUUID()] }), {
        status: 400,
        code: 'EVENT_POLICY_UNKNOWN_REFERENCE',
      });
      expect(await db.client.eventPolicyPlatform.count({ where: { eventPolicy: { eventId } } })).toBe(0);

      // Control: the platform that exists, alone.
      await updatePolicy(host, eventId, { allowedPlatformIds: [tabletop.id] }).expect(200);
    });
  });

  describe("a date's own policy (#796, #1211)", () => {
    it('serves a date that leaves adding games to the host under an event that votes, and refuses a nomination for that date alone', async () => {
      const host = await actors.user();
      const {
        eventId,
        dateIds: [dateId],
      } = await createdWithDates(host, { gameAdditionMode: GameAdditionMode.RequiresVote });

      const written = occurrencePolicyEnvelope(
        await updateDatePolicy(host, eventId, dateId, { gameAdditionMode: GameAdditionMode.HostOnly }).expect(200),
        'PATCH /api/events/:eventId/occurrences/:occurrenceId/policy as the host',
      );
      expect(written).toEqual(
        expect.objectContaining({ occurrenceId: dateId, gameAdditionMode: GameAdditionMode.HostOnly }),
      );

      // The read serves the date's overrides on their own, beside the event's
      // policy, which still asks for a vote: everything else is the event's.
      const read = await readEvent(host, eventId);
      expect(read.policy?.gameAdditionMode).toBe(GameAdditionMode.RequiresVote);
      expect(read.occurrencePolicies.map(({ occurrenceId }) => occurrenceId)).toEqual([dateId]);
      expect(fieldsSet(read.occurrencePolicies[0])).toEqual({ gameAdditionMode: GameAdditionMode.HostOnly });

      // The same offered game, for the date and then for the event: only the
      // date leaves adding games to the host.
      const entry = await arrangeListEntry(db.client, eventId, host.user.id);
      const body = { platformGameId: entry.platformGameId, suppliedFromId: entry.suppliedById };

      await nominate(host, eventId, { ...body, occurrenceId: dateId }).expect(403);
      expect(await db.client.eventGameNomination.count({ where: { eventId } })).toBe(0);

      const nomination = nominationEnvelope(
        await nominate(host, eventId, body).expect(201),
        'POST /api/events/:eventId/nominations for the event',
      );
      expect(nomination).toEqual(expect.objectContaining({ occurrenceId: null, status: NominationStatus.Open }));
    });

    it("refuses an organizer a date's policy, though they set one on an event they host and may edit this date", async () => {
      // An organizer holds `update:event_occurrence` but not
      // `update:event_policy`. This one hosts another event, so they hold the
      // policy grant there, the route's type-level check passes them, and only
      // the binding to this event's policy is left to refuse them.
      const host = await actors.user();
      const organizer = await actors.user();
      const {
        eventId,
        dateIds: [dateId],
      } = await createdWithDates(host);
      const {
        eventId: ownEventId,
        dateIds: [ownDateId],
      } = await createdWithDates(organizer);
      await addAttendee(host, eventId, { userId: organizer.user.id, role: SystemRole.EventOrganizer }).expect(201);

      // Control: the organizer sets a date's policy on the event they host.
      await updateDatePolicy(organizer, ownEventId, ownDateId, { allowSpectators: false }).expect(200);

      const before = await storedDatePolicy(dateId);
      await updateDatePolicy(organizer, eventId, dateId, { allowSpectators: false }).expect(403);
      expect(await storedDatePolicy(dateId)).toEqual(before);

      // Control: the same organizer edits the date itself.
      const relabelled = occurrenceEnvelope(
        await request(baseUrl)
          .patch(`${EVENTS_PATH}/${eventId}/occurrences/${dateId}`)
          .set(organizer.headers)
          .send({ label: 'Saturday evening' })
          .expect(200),
        'PATCH /api/events/:eventId/occurrences/:occurrenceId as the organizer',
      );
      expect(relabelled.label).toBe('Saturday evening');
    });

    it("serves a date's policy as null to a key that may read the event and its dates but not the policy", async () => {
      const host = await actors.user();
      const {
        eventId,
        dateIds: [dateId],
      } = await createdWithDates(host);
      await updateDatePolicy(host, eventId, dateId, { gameAdditionMode: GameAdditionMode.HostOnly }).expect(200);
      const key = await mintApiKey(baseUrl, db.client, host, [
        { slugs: ['read:event'], resourceType: ResourceType.Event },
        { slugs: ['read:event_occurrence'], resourceType: ResourceType.EventOccurrence },
      ]);

      const asKey = await readDate(key, eventId, dateId);
      expect(asKey.id).toBe(dateId);
      expect(asKey.policy).toBeNull();

      // The event's read hides the dates' policies with the event's.
      const eventAsKey = await readEvent(key, eventId);
      expect(eventAsKey.policy).toBeNull();
      expect(eventAsKey.occurrencePolicies).toEqual([]);

      // Control: the key's owner reads the same date's policy, so the null is
      // the key's missing read and not a date that sets nothing.
      const asHost = await readDate(host, eventId, dateId);
      expect(asHost.policy).toEqual(
        expect.objectContaining({ occurrenceId: dateId, gameAdditionMode: GameAdditionMode.HostOnly }),
      );
    });

    it("makes a date's policy on a first change that sets only a list, and records nothing for a re-send in another order", async () => {
      // A create writes an empty policy row for each date it makes, but a
      // date added on its own route has none, so this change makes the row.
      const host = await actors.user();
      const eventId = await createdEventId(host);
      const dateId = await addedDateId(host, eventId);
      expect(await storedDatePolicy(dateId)).toBeNull();
      expect((await readEvent(host, eventId)).occurrencePolicies).toEqual([]);

      const written = occurrencePolicyEnvelope(
        await updateDatePolicy(host, eventId, dateId, {
          allowedPlatformTypes: [PlatformType.Tabletop, PlatformType.Console],
        }).expect(200),
        "PATCH /api/events/:eventId/occurrences/:occurrenceId/policy with only a list, the date's first",
      );
      // Served sorted, as every stored list is.
      expect(written?.allowedPlatformTypes).toEqual([PlatformType.Console, PlatformType.Tabletop]);
      expect((await readEvent(host, eventId)).occurrencePolicies).toEqual([
        expect.objectContaining({
          occurrenceId: dateId,
          allowedPlatformTypes: [PlatformType.Console, PlatformType.Tabletop],
        }),
      ]);

      const stored = await storedDatePolicy(dateId);
      if (!stored) {
        throw new Error(`date ${dateId} has no policy row after its first change`);
      }

      // The same members in another order: the row, its updatedAt and its
      // list rows, ids and all, stay as they were (#1268).
      await updateDatePolicy(host, eventId, dateId, {
        allowedPlatformTypes: [PlatformType.Console, PlatformType.Tabletop],
      }).expect(200);
      expect(await storedDatePolicy(dateId)).toEqual(stored);

      // An absence is only worth asserting once this harness is shown to
      // record a change at all, so a real change runs after the re-send and
      // its entry is polled for. Entries land in the order their changes were
      // emitted, so one from the re-send would be in the list the poll
      // returns (#728).
      await updateDatePolicy(host, eventId, dateId, { allowSpectators: false }).expect(200);

      const entries = await auditEntriesOnceOneChanges(dateId, 'allowSpectators');
      expect(entries.map(({ payload }) => payload)).toEqual([
        {
          before: { id: stored.id, allowedPlatformTypes: [] },
          after: { id: stored.id, allowedPlatformTypes: [PlatformType.Console, PlatformType.Tabletop] },
        },
        {
          before: { id: stored.id, allowSpectators: null },
          after: { id: stored.id, allowSpectators: false },
        },
      ]);
    });
  });

  describe('the occurrence override scope (#796)', () => {
    it("lets a date lift the event's platform types under the default Any scope, and serves the flag", async () => {
      const host = await actors.user();
      const {
        eventId,
        dateIds: [dateId],
      } = await createdWithDates(host, { allowedPlatformTypes: [PlatformType.Tabletop] });

      await updateDatePolicy(host, eventId, dateId, { platformTypesUnrestricted: true }).expect(200);

      const read = await readEvent(host, eventId);
      expect(read.policy?.occurrenceOverrideScope).toBe(OccurrenceOverrideScope.Any);
      expect(read.occurrencePolicies).toEqual([
        expect.objectContaining({ occurrenceId: dateId, platformTypesUnrestricted: true, allowedPlatformTypes: [] }),
      ]);
    });

    it('refuses a switch to TightenOnly while a date lifts a restriction, naming that date alone, and makes it once the date drops the flag', async () => {
      const host = await actors.user();
      const {
        eventId,
        dateIds: [liftingDateId, otherDateId],
      } = await createdWithDates(host, { allowedPlatformTypes: [PlatformType.Tabletop] }, ['Saturday', 'Sunday']);
      await updateDatePolicy(host, eventId, liftingDateId, { platformTypesUnrestricted: true }).expect(200);
      // The other date overrides a field the scope doesn't cover, so it stays
      // within any scope and isn't named.
      await updateDatePolicy(host, eventId, otherDateId, { gameAdditionMode: GameAdditionMode.HostOnly }).expect(200);

      const refused = await updatePolicy(host, eventId, {
        occurrenceOverrideScope: OccurrenceOverrideScope.TightenOnly,
      });
      expectErrorEnvelope(refused, { status: 400, code: 'EVENT_POLICY_OCCURRENCES_EXCEED_SCOPE' });
      expect(refused.body.occurrenceIds).toEqual([liftingDateId]);

      // Nothing the date sets is cleared on the host's behalf, and the scope stays.
      expect((await storedDatePolicy(liftingDateId))?.platformTypesUnrestricted).toBe(true);
      expect(
        await db.client.eventPolicy.findUniqueOrThrow({
          where: { eventId },
          select: { occurrenceOverrideScope: true },
        }),
      ).toEqual({ occurrenceOverrideScope: OccurrenceOverrideScope.Any });

      await updateDatePolicy(host, eventId, liftingDateId, { platformTypesUnrestricted: false }).expect(200);

      const switched = eventPolicyEnvelope(
        await updatePolicy(host, eventId, { occurrenceOverrideScope: OccurrenceOverrideScope.TightenOnly }).expect(200),
        'PATCH /api/events/:eventId/policy to TightenOnly once no date lifts a restriction',
      );
      expect(switched?.occurrenceOverrideScope).toBe(OccurrenceOverrideScope.TightenOnly);
    });

    it("refuses a date that swaps the event's Tabletop for Console under TightenOnly, and takes one that keeps to Tabletop", async () => {
      const host = await actors.user();
      const {
        eventId,
        dateIds: [dateId],
      } = await createdWithDates(host, {
        allowedPlatformTypes: [PlatformType.Tabletop],
        occurrenceOverrideScope: OccurrenceOverrideScope.TightenOnly,
      });

      const before = await storedDatePolicy(dateId);
      expectErrorEnvelope(
        await updateDatePolicy(host, eventId, dateId, { allowedPlatformTypes: [PlatformType.Console] }),
        { status: 400, code: 'EVENT_OCCURRENCE_OVERRIDE_NOT_ALLOWED' },
      );
      expect(await storedDatePolicy(dateId)).toEqual(before);

      // Control: a list within the event's, on the same date.
      const narrowed = occurrencePolicyEnvelope(
        await updateDatePolicy(host, eventId, dateId, { allowedPlatformTypes: [PlatformType.Tabletop] }).expect(200),
        "PATCH /api/events/:eventId/occurrences/:occurrenceId/policy within the event's platform types",
      );
      expect(narrowed?.allowedPlatformTypes).toEqual([PlatformType.Tabletop]);
    });
  });
});
