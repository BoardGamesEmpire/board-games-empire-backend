import {
  Action,
  createOrReplay,
  DatabaseService,
  Event,
  EventParticipationStatus,
  EventSchedulingMode,
  isPrismaDependentRecordNotFoundError,
  normalizeClientRequestId,
  OccurrenceStatus,
  Prisma,
  ResourceType,
  SystemRole,
} from '@bge/database';
import { lockExistingHousehold } from '@bge/household';
import { t } from '@bge/i18n';
import { AbilityService, PermissionsService, resolveScopeSubjectId, ScopeComposer } from '@bge/permissions';
import { PaginationQueryDto, type PaginatedRows } from '@bge/shared';
import { webhookEnvelope, WebhookEventType } from '@bge/webhooks';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import assert from 'node:assert';
import { isDeepStrictEqual } from 'node:util';
import { assertInvitable } from './attendee/invitable';
import { ATTENDEE_ORDER } from './constants/attendee-order.constant';
import { ATTENDEE_USER_AND_ROLE_INCLUDE } from './constants/attendee-user-and-role.constant';
import {
  EVENT_CREATE_ATTENDEE_INCLUDE,
  EVENT_CREATE_INCLUDE,
  type CreatedEvent,
} from './constants/event-create-include.constant';
import { NOT_REMOVED } from './constants/not-removed.constant';
import { OCCURRENCE_ORDER } from './constants/occurrence-order.constant';
import type { CreateEventDto } from './dto/create-event.dto';
import type { UpdateEventDto } from './dto/update-event.dto';
import { EventCreatedEvent, EventDeletedEvent, EventUpdatedEvent } from './events/event.events';
import { pickSnapshot } from './utils/pick-snapshot.util';

@Injectable()
export class EventService {
  private readonly logger = new Logger(EventService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly eventEmitter: EventEmitter2,
    private readonly abilityService: AbilityService,
    private readonly permissions: PermissionsService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  /**
   * One page of the events the caller is an attendee of, plus the total
   * matching count for the response envelope (#372).
   *
   * The scope is the endpoint's own: events with an attendee row for the
   * caller, hosts included, since creating an event makes its host an
   * attendee (#512, #365). The row counts whatever its RSVP status, so an
   * invitation or a declined event is listed too. An RSVP changes only the
   * row's status, not any event role attached to it, so filtering on status
   * here would hide events the caller can still read and answer. A row a host
   * removed does not count: it keeps no role, so the event is no longer the
   * caller's to answer (#551). Before this the caller's ceiling WAS the scope, so
   * the one route returned a plain user their events, a household member every
   * event in their households, a friend their friends' `Friends`-visible events
   * and staff every event on the server. The ceiling is still ANDed in, as the
   * limit rather than the answer: for an `apiKey` actor it carries the
   * key ∩ owner floor. It limits which events are listed, not what each one
   * embeds: the occurrences and policy below come with every listed event and
   * are not clipped by their own types' ceilings. An event the list no longer
   * shows stays readable by id for whoever could read it before. It is
   * narrowed out of the list, not withdrawn.
   *
   * `deletedAt: null` stays beside the scope. A soft delete keeps the attendee
   * rows, so the attendance clause alone still matches a deleted event.
   *
   * `resolveScopeSubjectId` refuses `plugin`, `system` and `external` actors:
   * "the events I attend" has no meaning without a user, and the refusal must
   * never soften into an empty page. PROVISIONAL — #395.
   *
   * Rows and count come from one REPEATABLE READ snapshot, so an event created
   * or soft-deleted between the two statements cannot make `total` describe a
   * list the caller was not served.
   */
  async getEvents(pagination: PaginationQueryDto): Promise<PaginatedRows<Event>> {
    const userId = resolveScopeSubjectId(this.abilityService);

    const where = this.scopeComposer.compose(ResourceType.Event, Action.read, {
      deletedAt: null,
      attendees: { some: { userId, ...NOT_REMOVED } },
    });

    const [rows, total] = await this.db.$transaction(
      [
        this.db.event.findMany({
          where,
          include: {
            // Unbounded: every occurrence of every event on the page, which is
            // a larger read than the one `GET /events/:eventId/occurrences` was
            // paginated to avoid. Capping it is #404 — it changes what this
            // endpoint serves, not how it wraps it.
            occurrences: {
              orderBy: OCCURRENCE_ORDER,
            },
            policy: true,
          },
          skip: pagination.skip,
          take: pagination.pageSize,
          // `id` breaks ties on `createdAt` so page boundaries hold between requests.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),

        this.db.event.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows, total };
  }

  /**
   * The event, with its occurrences, attendees and policy.
   *
   * Each of the three is a read of its own, under its own type's ceiling
   * (#560). Embedded in the event read, they went to whoever could read the
   * event: a friend of the host, or a household guest, got every attendee,
   * with the email address of each guest who has no account. Clipping them
   * inside the `include` would fail open (#559), so each ceiling sits in its
   * own read's top-level `where`, bound to this event. A caller with no read
   * on one of them gets `[]` for it, or `null` for the policy.
   *
   * The four reads share one REPEATABLE READ snapshot, as the list's rows and
   * count do, so the parts describe the event at one moment. They run whether
   * or not the caller can read the event; if not, the 404 discards them. Each
   * is an indexed lookup by event, so a 404 costs three small reads. Reading
   * the event first would cost every 200 an interactive transaction, or the
   * shared snapshot.
   *
   * The occurrences and attendees are unbounded, as the embed was. Capping
   * them is #404's.
   */
  async getEventById(id: string): Promise<EventDetail> {
    const [event, occurrences, attendees, policy] = await this.db.$transaction(
      [
        this.db.event.findUnique({
          where: {
            id,
            deletedAt: null,
            // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.Event, Action.read),
          },
        }),

        this.db.eventOccurrence.findMany({
          where: this.scopeComposer.compose(ResourceType.EventOccurrence, Action.read, { eventId: id }),
          orderBy: OCCURRENCE_ORDER,
        }),

        this.db.eventAttendee.findMany({
          where: this.scopeComposer.compose(ResourceType.EventAttendee, Action.read, { eventId: id, ...NOT_REMOVED }),
          include: ATTENDEE_USER_AND_ROLE_INCLUDE,
          orderBy: ATTENDEE_ORDER,
        }),

        this.db.eventPolicy.findUnique({
          where: {
            eventId: id,
            // eslint-disable-next-line no-restricted-syntax -- the event's one policy row, not a collection read
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventPolicy, Action.read),
          },
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    assert(event, new NotFoundException(t('errors.event.not_found', { id })));
    return { ...event, occurrences, attendees, policy };
  }

  async createEvent(dto: CreateEventDto): Promise<Event> {
    const initiatedAt = new Date();
    const userId = this.abilityService.getActingUserId();
    const {
      occurrences,
      policy,
      householdId = null,
      inviteUserIds = [],
      clientRequestId: rawClientRequestId,
      ...eventFields
    } = dto;
    const clientRequestId = normalizeClientRequestId(rawClientRequestId);
    const uniqueInviteIds = Array.from(new Set(inviteUserIds.filter((id) => id !== userId)));

    // A retried create finds the event its first attempt made before any
    // check below runs (#252). The checks judged the original; a household
    // deleted or an invitee who blocked the creator since must not turn the
    // retry of a create that succeeded into a 404 or a 403.
    const { row: event, replayed } = await createOrReplay<CreatedEvent>({
      clientRequestId,
      find: (key) => this.findReplayedEvent(userId, key),
      logger: this.logger,
      label: 'event create',
      create: async () => {
        // The route's type-level check passes every user, since `create:event`
        // exists for all of them. What decides it is the household the event
        // joins: `create:event` covers none, and each household's own grant
        // covers that household. `null` goes on the subject explicitly — the
        // matcher reads a missing field as `null`, so leaving it out would pass
        // any household as an event outside one. No role renders for a
        // soft-deleted or unknown household, so no household grant matches it.
        this.abilityService.assertCurrentActorCan(Action.create, ResourceType.Event, { householdId });

        this.validateOccurrencesForMode(dto.schedulingMode ?? EventSchedulingMode.Fixed, occurrences);

        return this.db.$transaction(async (tx) => {
          // The check above cannot settle whether the household is still live.
          // It read a graph that may predate a soft-delete, since the graph is
          // cached and eviction is best-effort, and a delete can commit after the
          // graph was built. The site Owner's grant names no household at all.
          // The share lock answers a dead or unknown household with 404, and holds
          // a concurrent soft-delete off until this event is written.
          if (householdId !== null) {
            await lockExistingHousehold(tx, householdId);
          }

          await assertInvitable(tx, userId, uniqueInviteIds);

          return tx.event.create({
            data: {
              ...eventFields,
              clientRequestId,

              household: householdId !== null ? { connect: { id: householdId } } : undefined,

              createdBy: { connect: { id: userId } },

              occurrences:
                occurrences && occurrences.length > 0
                  ? {
                      create: occurrences.map((occ, idx) => ({
                        label: occ.label,
                        startDate: occ.startDate,
                        endDate: occ.endDate,
                        location: occ.location,
                        sortOrder: occ.sortOrder ?? idx,
                        policy: dto.schedulingMode === EventSchedulingMode.Poll ? undefined : { create: {} },
                        status:
                          dto.schedulingMode === EventSchedulingMode.Poll
                            ? OccurrenceStatus.Proposed
                            : OccurrenceStatus.Confirmed,
                        confirmedAt: dto.schedulingMode === EventSchedulingMode.Poll ? null : new Date(),
                      })),
                    }
                  : undefined,

              policy: {
                create: policy
                  ? {
                      allowMemberInvites: policy.allowMemberInvites,
                      allowGuestInvites: policy.allowGuestInvites,
                      maxAttendees: policy.maxAttendees,
                      requireHostApprovalToJoin: policy.requireHostApprovalToJoin,
                      allowSpectators: policy.allowSpectators,
                      maxTotalParticipants: policy.maxTotalParticipants,
                      strictCapacity: policy.strictCapacity,
                      gameAdditionMode: policy.gameAdditionMode,
                      restrictToAttendeePool: policy.restrictToAttendeePool,
                      restrictToGameCategories: policy.restrictToGameCategories,
                      fillerMaxPlayTime: policy.fillerMaxPlayTime,
                      voteThresholdType: policy.voteThresholdType,
                      voteThresholdValue: policy.voteThresholdValue,
                      voteQuorumType: policy.voteQuorumType,
                      voteQuorumValue: policy.voteQuorumValue,
                      voteEligibility: policy.voteEligibility,
                      interestedWeight: policy.interestedWeight,
                      votingWindowHours: policy.votingWindowHours,
                      ...(policy.allowedCategoryIds?.length
                        ? {
                            allowedCategories: {
                              create: policy.allowedCategoryIds.map((catId) => ({
                                category: { connect: { id: catId } },
                              })),
                            },
                          }
                        : {}),
                      // always create an event policy -- even an empty one
                    }
                  : {},
              },

              attendees: {
                create: [
                  // The creator joins as the event's host
                  {
                    user: { connect: { id: userId } },
                    status: EventParticipationStatus.Attending,
                    role: {
                      create: {
                        role: { connect: { name: SystemRole.EventHost } },
                      },
                    },
                  },
                  ...uniqueInviteIds.map((inviteId) => ({
                    user: { connect: { id: inviteId } },
                    status: EventParticipationStatus.Invited,
                    role: {
                      create: {
                        role: { connect: { name: SystemRole.EventParticipant } },
                      },
                    },
                  })),
                ],
              },
            },

            include: EVENT_CREATE_INCLUDE,
          });
        });
      },
    });

    if (replayed) {
      // A replay emits nothing (#252): the original emitted once it
      // committed, and a second round would notify its invitees and fire its
      // webhook twice. It has already evicted, in `findReplayedEvent`.
      //
      // Known residual: an original that committed but crashed before its
      // emits leaves its invitees unnotified, and the replay does not make up
      // for it. Emitting here would notify twice in the far commoner case
      // where the original's emits ran, and nothing records which case this is.
      return event;
    }

    // The creator's graph was cached by this request, before the host row
    // existed, and each invitee's predates their participant row. Without the
    // eviction none of them holds a role on the event until the cache expires.
    //
    // The eviction is for these users' own next requests. The webhook
    // dispatcher reads each subscriber's graph from the database, so it doesn't
    // depend on this running before the emits (#732).
    await this.permissions.invalidateUsers([userId, ...uniqueInviteIds]);

    this.eventEmitter.emit(
      EventCreatedEvent.eventName,
      new EventCreatedEvent(
        {
          id: event.id,
          title: event.title,
          schedulingMode: event.schedulingMode,
          createdById: event.createdById,
          householdId: event.householdId,
        },
        uniqueInviteIds,
        initiatedAt,
      ),
    );

    this.eventEmitter.emit(
      WebhookEventType.EventCreated,
      webhookEnvelope({
        subjectId: event.id,
        householdId: event.householdId,
        // An event is created once, so its id names this occurrence.
        occurrenceId: event.id,
        data: this.webhookIds(event),
      }),
    );

    // Here rather than in the controller, which cannot tell a replay from a
    // create: a retried create made nothing, and must not log that it did.
    this.logger.log(`Event "${event.title}" (${event.id}) created by user ${event.createdById}`);

    return event;
  }

  /**
   * The event a keyed create made under `clientRequestId`, for its replay
   * (#252), in the shape the create returned it.
   *
   * The row comes back whatever has happened to it since, soft delete
   * included: it is the creator's own create, and its outcome. The parts are
   * other users' data, so each is read under its own type's ceiling, as
   * `getEventById` reads them (#560), and a removed attendee is left out. A
   * creator who still hosts the event gets what the create answered; one who
   * has lost read on it since gets the event and only what they may still
   * see of it.
   *
   * A row found here is always a replay, so this is also where the replay
   * evicts, before the parts are read.
   */
  private async findReplayedEvent(userId: string, clientRequestId: string): Promise<CreatedEvent | null> {
    const event = await this.db.event.findUnique({
      where: { createdById_clientRequestId: { createdById: userId, clientRequestId } },
    });

    if (!event) {
      return null;
    }

    // A replay evicts, as the original did: eviction is idempotent, and it
    // heals an original that committed but crashed before its own eviction
    // ran. Nothing records which attendee rows the create made, so it evicts
    // every user with a row on the event now: the original's host and
    // invitees, and anyone added or removed since, whose own add or removal
    // evicted them already and costs one graph rebuild here. The retry's
    // invitees were never added. Read unscoped, unlike the parts below: whose
    // graph is stale does not depend on whom the creator may see.
    const rows = await this.db.eventAttendee.findMany({ where: { eventId: event.id }, select: { userId: true } });

    await this.permissions.invalidateUsers(
      Array.from(new Set([userId, ...rows.flatMap(({ userId: id }) => (id === null ? [] : [id]))])),
    );

    // Then this request's abilities are resolved again. They were primed when
    // it began, which for the loser of a concurrent create is before the
    // winner committed the host role, and after a crash before the original's
    // eviction they came from the stale graph. Outside a household that role
    // is the creator's only read on the parts, so the replay answered with no
    // attendees and no policy. Re-priming the current actor keeps an API key's
    // restriction: the key's scope is resolved again with the user's graph.
    await this.abilityService.primeCurrentActor();

    const [occurrences, attendees, policy] = await this.db.$transaction(
      [
        this.db.eventOccurrence.findMany({
          where: this.scopeComposer.compose(ResourceType.EventOccurrence, Action.read, { eventId: event.id }),
          orderBy: OCCURRENCE_ORDER,
        }),

        this.db.eventAttendee.findMany({
          where: this.scopeComposer.compose(ResourceType.EventAttendee, Action.read, {
            eventId: event.id,
            ...NOT_REMOVED,
          }),
          include: EVENT_CREATE_ATTENDEE_INCLUDE,
          orderBy: ATTENDEE_ORDER,
        }),

        this.db.eventPolicy.findUnique({
          where: {
            eventId: event.id,
            // eslint-disable-next-line no-restricted-syntax -- the event's one policy row, not a collection read
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventPolicy, Action.read),
          },
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { ...event, occurrences, attendees, policy };
  }

  async updateEvent(id: string, dto: UpdateEventDto): Promise<Event> {
    const initiatedAt = new Date();
    assert(Object.keys(dto).length > 0, new BadRequestException(t('common.at_least_one_field')));

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { occurrences: _occurrences, policy: _policy, inviteUserIds: _inviteUserIds, ...fields } = dto;

    try {
      // Full row (not a count) so the update event can carry a before snapshot.
      const existing = await this.db.event.findUnique({
        where: { id, deletedAt: null },
      });
      assert(existing, new NotFoundException(t('errors.event.not_found', { id })));

      const updated = await this.db.event.update({
        where: {
          id,
          // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Event, Action.update),
        },
        data: fields,
        include: {
          occurrences: { orderBy: OCCURRENCE_ORDER },
          policy: true,
        },
      });

      const changedKeys = Object.keys(fields) as (keyof Event)[];
      // The audit row records the columns the patch named, before and after,
      // even a value re-sent unchanged, as every update in this lib does
      // (`pickSnapshot`). A PATCH touching only relation-managed inputs
      // (occurrences / policy / inviteUserIds) names no Event column, so it
      // writes none.
      if (changedKeys.length > 0) {
        this.eventEmitter.emit(
          EventUpdatedEvent.eventName,
          new EventUpdatedEvent(pickSnapshot(existing, changedKeys), pickSnapshot(updated, changedKeys), initiatedAt),
        );

        // The columns whose values changed, not every key the patch sent, so
        // a form that re-sends what it loaded tells no subscriber anything.
        // Their names, never their values: a receiver reads the values with
        // its own credentials. No occurrenceId, since nothing here names one
        // update stably (#127), so each emit is its own delivery.
        const changedFields = changedKeys.filter((key) => !isDeepStrictEqual(existing[key], updated[key]));
        if (changedFields.length > 0) {
          this.eventEmitter.emit(
            WebhookEventType.EventUpdated,
            webhookEnvelope({
              subjectId: updated.id,
              householdId: updated.householdId,
              data: { ...this.webhookIds(updated), changedFields },
            }),
          );
        }
      }

      return updated;
    } catch (error) {
      this.logger.error(`Error updating event with ID ${id}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.update'));
      }

      throw error;
    }
  }

  async deleteEvent(id: string): Promise<Event> {
    const initiatedAt = new Date();
    const userId = this.abilityService.getActingUserId();
    try {
      const existing = await this.db.event.count({
        where: { id, deletedAt: null },
      });
      assert(existing > 0, new NotFoundException(t('errors.event.not_found', { id })));

      const event = await this.db.event.update({
        where: {
          id,
          // eslint-disable-next-line no-restricted-syntax -- single-row soft delete by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Event, Action.delete),
        },
        data: {
          deletedAt: new Date(),
          deletedById: userId,
        },
      });

      this.eventEmitter.emit(
        EventDeletedEvent.eventName,
        new EventDeletedEvent(
          { id: event.id, title: event.title, createdById: event.createdById, householdId: event.householdId },
          initiatedAt,
        ),
      );

      // Emitted after the delete commits, so the descriptor marks the subject
      // deleted and dispatch reads the deleted row. Nothing restores an event,
      // so its id names this occurrence.
      this.eventEmitter.emit(
        WebhookEventType.EventDeleted,
        webhookEnvelope({
          subjectId: event.id,
          householdId: event.householdId,
          occurrenceId: event.id,
          data: this.webhookIds(event),
        }),
      );

      return event;
    } catch (error) {
      this.logger.error(`Error deleting event with ID ${id}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.delete'));
      }

      throw error;
    }
  }

  /**
   * What every Event webhook carries: ids only. `data` is copied verbatim to a
   * URL the subscriber controls, and an event's title, description and
   * `location` (which may be a home address) are not the subscriber's to
   * forward. A receiver that wants them reads the event with its own
   * credentials and gets what that read allows.
   */
  private webhookIds(event: Pick<Event, 'id' | 'householdId'>): { eventId: string; householdId: string | null } {
    return { eventId: event.id, householdId: event.householdId };
  }

  private validateOccurrencesForMode(mode: EventSchedulingMode, occurrences?: CreateEventDto['occurrences']): void {
    if (mode === EventSchedulingMode.Fixed && occurrences && occurrences.length > 1) {
      throw new BadRequestException(t('errors.event.fixed_mode_single'));
    }
  }
}

/**
 * `GET /events/:id`. The shape is the one the event read embedded before
 * #560, so the route's response is unchanged; only who gets each part is.
 */
export type EventDetail = Prisma.EventGetPayload<{
  include: {
    occurrences: true;
    attendees: { include: typeof ATTENDEE_USER_AND_ROLE_INCLUDE };
    policy: true;
  };
}>;
