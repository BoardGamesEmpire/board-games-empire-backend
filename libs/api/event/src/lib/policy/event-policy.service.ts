import {
  Action,
  DatabaseService,
  isPrismaDependentRecordNotFoundError,
  ResourceType,
  type EventOccurrencePolicy,
  type EventPolicy,
  type Prisma,
} from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { AbilityService } from '@bge/permissions';
import { webhookEnvelope, WebhookEventType } from '@bge/webhooks';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Http } from '@status/codes';
import assert from 'node:assert';
import { eventWebhookIds } from '../event.service';
import { lockLiveEvent } from '../utils/lock-live-event.util';
import type { UpdateEventPolicyDto } from './dto/update-event-policy.dto';
import type { UpdateOccurrencePolicyDto } from './dto/update-occurrence-policy.dto';
import { assertValidVotingPolicy, foldPolicy } from './effective-policy';
import { EventPolicyUpdatedEvent, OccurrencePolicyUpdatedEvent } from './events/event-policy.events';
import { assertWithinOverrideScope, occurrencesExceedingScope } from './override-scope';
import { canReadEventPolicy, readEventPolicyView, serveOccurrencePolicy } from './policy-ceiling';
import {
  assertPolicyReferencesExist,
  policyChange,
  policyColumnsUpdate,
  replaceEventPolicyLists,
  replaceOccurrencePolicyLists,
  splitPolicyPatch,
} from './policy-lists';
import {
  POLICY_VIEW_INCLUDE,
  toEventPolicyView,
  toOccurrencePolicyView,
  type EventPolicyView,
  type OccurrencePolicyView,
  type PolicyListsView,
} from './policy-view';

/** The columns of a date's own policy, without the row's identity and timestamps. */
type OccurrencePolicyColumns = Omit<EventOccurrencePolicy, 'id' | 'occurrenceId' | 'createdAt' | 'updatedAt'>;

/** A date's own policy as it is served, its columns and its lists, without the row's identity and timestamps. */
type OccurrencePolicyColumnsAndLists = OccurrencePolicyColumns & PolicyListsView;

/**
 * A date's policy before its first write: it sets nothing of its own, so each
 * field is the event's, and no "no restriction" flag is set. The schema's
 * defaults, for a date that has no row yet (#796).
 */
const NO_OCCURRENCE_OVERRIDES: Readonly<OccurrencePolicyColumnsAndLists> = {
  restrictToGameCategories: null,
  allowedCategoryIds: [],
  allowedPlatformTypes: [],
  allowedPlatformIds: [],
  platformTypesUnrestricted: false,
  platformsUnrestricted: false,
  maxAttendees: null,
  maxTotalParticipants: null,
  strictCapacity: null,
  capacityUnrestricted: false,
  requireHostApprovalToJoin: null,
  allowSpectators: null,
  gameAdditionMode: null,
  restrictToAttendeePool: null,
  fillerMaxPlayTime: null,
  voteThresholdType: null,
  voteThresholdValue: null,
  voteQuorumType: null,
  voteQuorumValue: null,
  voteEligibility: null,
  interestedWeight: null,
  votingWindowHours: null,
};

@Injectable()
export class EventPolicyService {
  private readonly logger = new Logger(EventPolicyService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly eventEmitter: EventEmitter2,
    private readonly abilityService: AbilityService,
  ) {}

  /**
   * Changes an event's policy under its own grant (#796): `update:event_policy`
   * for the event's hosts, or its household variant for the household's owners
   * and admins. An organizer may edit the event but not its policy.
   *
   * The write takes the event's lock first, which date writes take too, so the
   * stored policy and the dates' overrides it is judged against can't change
   * before it lands, and a deleted event answers 404. The policy is read next
   * under the grant's ceiling, so the grant is checked before the patch is
   * judged, and it is the ceiling on the write too. The patch is judged as the policy it leaves: the
   * stored row with the patch over it, and that folded under each date's
   * overrides, since a date that sets only a threshold type relies on the
   * event's value.
   *
   * Each date's own restrictions are judged against the override scope and
   * the restrictions the patch leaves (#796). A patch that would leave a date
   * past them, by tightening the scope or narrowing a restriction a
   * TightenOnly date stays within, answers 400 naming those dates. The host
   * changes them first; nothing a date sets is cleared on their behalf.
   *
   * Work in flight is left as it is. An open nomination finishes the process it
   * started in, a resolve uses the policy in force when it runs, and a voting
   * deadline already set stays.
   *
   * The allowed lists replace the stored ones when sent (#1268). One equal to
   * the stored set, in any order, is not a change, and one that differs is, so a
   * patch that changes only a list still emits, with the list's name among the
   * changed fields.
   *
   * The answer is the row read back under the read ceiling, so a writer who may
   * change the policy but not read it gets `null`. Only the columns whose values
   * changed are audited, and a patch that changes none emits nothing (#728).
   */
  async updatePolicy(eventId: string, dto: UpdateEventPolicyDto): Promise<EventPolicyView | null> {
    const initiatedAt = new Date();
    assert(Object.keys(dto).length > 0, new BadRequestException(t('common.at_least_one_field')));

    try {
      const { event, existing, updated, columns, policy, lists } = await this.db.$transaction(async (tx) => {
        const event = await lockLiveEvent(tx, eventId);
        const { updateCeiling, policy: existing } = await this.readPolicyToUpdate(tx, eventId);

        const { columns, lists } = splitPolicyPatch(existing, dto);

        const storedOccurrencePolicies = (
          await tx.eventOccurrencePolicy.findMany({
            where: { occurrence: { eventId } },
            include: POLICY_VIEW_INCLUDE,
          })
        ).map(toOccurrencePolicyView);

        // The policy the patch leaves: the stored row with the patch over
        // it, and each list sent in place of the stored one.
        const merged = { ...existing, ...columns, ...lists.after };
        assertValidVotingPolicy(merged);
        for (const occurrencePolicy of storedOccurrencePolicies) {
          assertValidVotingPolicy(foldPolicy(merged, occurrencePolicy));
        }

        // Every date's own restrictions stay within the scope the patch
        // leaves, measured against the restrictions it leaves (#796). The
        // dates in the way are named, and the host changes them first.
        const exceeding = occurrencesExceedingScope(merged, storedOccurrencePolicies, merged.occurrenceOverrideScope);
        if (exceeding.length > 0) {
          throw new CodedHttpException(
            Http.BadRequest,
            'EVENT_POLICY_OCCURRENCES_EXCEED_SCOPE',
            t('errors.event_policy.occurrences_exceed_scope', { count: exceeding.length }),
            { fields: { occurrenceIds: exceeding } },
          );
        }

        await assertPolicyReferencesExist(tx, {
          platformIds: dto.allowedPlatformIds,
          categoryIds: dto.allowedCategoryIds,
        });

        const updated = await tx.eventPolicy.update({
          where: { eventId, AND: updateCeiling },
          data: policyColumnsUpdate(columns, lists),
        });

        // Only a list that differs is rewritten, so a re-sent list costs no writes.
        await replaceEventPolicyLists(tx, existing.id, lists.after);

        const policy = await readEventPolicyView(tx, this.abilityService, eventId);

        return { event, existing, updated, columns, policy, lists };
      });

      const { changed, before, after } = policyChange<EventPolicy>(
        existing,
        updated,
        Object.keys(columns) as (keyof EventPolicy)[],
        lists,
      );
      if (changed.length > 0) {
        this.eventEmitter.emit(
          EventPolicyUpdatedEvent.eventName,
          new EventPolicyUpdatedEvent(before, after, eventId, initiatedAt),
        );

        // Their names, never their values: `data` is copied verbatim to a URL
        // the subscriber controls, and a receiver reads the values with its
        // own credentials. The envelope's `occurrenceId`, its key for
        // deduplicating deliveries and not a date's id, is left unset: as
        // for `updateEvent`, each emit is its own delivery (#796).
        this.eventEmitter.emit(
          WebhookEventType.EventPolicyUpdated,
          webhookEnvelope({
            subjectId: updated.id,
            householdId: event.householdId,
            data: { ...eventWebhookIds(event), policyId: updated.id, changedFields: changed },
          }),
        );
      }

      return policy;
    } catch (error) {
      this.logger.error(`Error updating the policy of event ${eventId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.update'));
      }

      throw error;
    }
  }

  /**
   * Changes a date's own policy (#796): the fields it overrides for that day.
   * It is the event's policy with overrides, so it takes the event policy's
   * grant, `update:event_policy` or its household variant. An organizer may
   * edit the date but not its policy. `null` hands a field back to the
   * event's, and so does an empty list. The date's row is made on its first
   * write.
   *
   * The write takes the event's lock, as an event policy write and a date
   * write do. The grant is checked right after it, by reading the event's
   * policy under the update ceiling, before the date is looked up, so a caller
   * without it can't learn which dates are the event's: a date of another
   * event answers 404 only to a caller who holds it.
   *
   * The patch is judged as the date's policy it leaves: the stored row, or
   * nothing of the date's own before its first write, with the patch over it.
   * That folded over the event's policy must leave a voting policy a resolve
   * can apply, and it must stay within the event's override scope. A date
   * that says "no restriction" beside a restriction of the same kind is
   * invalid under any scope (#796).
   *
   * Nominations for the date are held to its policy as soon as this commits.
   * Work in flight is left as it is, as for the event's policy.
   *
   * The answer is the date's row read back, or `null` when the caller may
   * change the event's policy but not read it. Only what changed is audited,
   * on the date, and sent as the event's `event.policy.updated.v1` with the
   * date's id; a patch that changes nothing emits nothing (#728).
   */
  async updateOccurrencePolicy(
    eventId: string,
    occurrenceId: string,
    dto: UpdateOccurrencePolicyDto,
  ): Promise<OccurrencePolicyView | null> {
    const initiatedAt = new Date();
    assert(Object.keys(dto).length > 0, new BadRequestException(t('common.at_least_one_field')));

    try {
      const { event, eventPolicy, existing, updated, columns, lists, policy } = await this.db.$transaction(
        async (tx) => {
          const event = await lockLiveEvent(tx, eventId);
          const { policy: eventPolicy } = await this.readPolicyToUpdate(tx, eventId);

          const occurrence = await tx.eventOccurrence.findUnique({
            where: { id: occurrenceId, eventId },
            select: { id: true },
          });
          assert(occurrence, new NotFoundException(t('errors.occurrence.not_found', { occurrenceId, eventId })));

          const row = await tx.eventOccurrencePolicy.findUnique({
            where: { occurrenceId },
            include: POLICY_VIEW_INCLUDE,
          });
          const existing: OccurrencePolicyColumnsAndLists = row ? toOccurrencePolicyView(row) : NO_OCCURRENCE_OVERRIDES;

          const { columns, lists } = splitPolicyPatch(existing, dto);

          // The date's policy the patch leaves, lists included.
          const merged = { ...existing, ...columns, ...lists.after };
          assertValidVotingPolicy(foldPolicy(eventPolicy, merged));
          assertWithinOverrideScope(eventPolicy, merged, eventPolicy.occurrenceOverrideScope);

          await assertPolicyReferencesExist(tx, {
            platformIds: dto.allowedPlatformIds,
            categoryIds: dto.allowedCategoryIds,
          });

          const updated = await tx.eventOccurrencePolicy.upsert({
            where: { occurrenceId },
            create: { occurrenceId, ...columns },
            update: policyColumnsUpdate(columns, lists),
          });

          await replaceOccurrencePolicyLists(tx, updated.id, lists.after);

          // The row is read back only for an actor it is served to (#1211).
          const canReadPolicy = await canReadEventPolicy(tx, this.abilityService, eventId);
          const readBack = canReadPolicy
            ? await tx.eventOccurrencePolicy.findUniqueOrThrow({
                where: { id: updated.id },
                include: POLICY_VIEW_INCLUDE,
              })
            : null;
          const policy = serveOccurrencePolicy(readBack, canReadPolicy);

          return { event, eventPolicy, existing, updated, columns, lists, policy };
        },
      );

      // Before the date's first write there was no row, and every field was
      // the event's; the snapshots name the row that now holds them.
      const { changed, before, after } = policyChange<OccurrencePolicyColumns>(
        { ...existing, id: updated.id },
        updated,
        Object.keys(columns) as (keyof OccurrencePolicyColumns)[],
        lists,
      );
      if (changed.length > 0) {
        this.eventEmitter.emit(
          OccurrencePolicyUpdatedEvent.eventName,
          new OccurrencePolicyUpdatedEvent(before, after, occurrenceId, eventId, initiatedAt),
        );

        // The readers of the event's policy are the audience, so the subject
        // is the event's policy, and the date is named beside it. Names,
        // never values, as for the event's policy (#796).
        this.eventEmitter.emit(
          WebhookEventType.EventPolicyUpdated,
          webhookEnvelope({
            subjectId: eventPolicy.id,
            householdId: event.householdId,
            data: {
              ...eventWebhookIds(event),
              policyId: eventPolicy.id,
              eventOccurrenceId: occurrenceId,
              changedFields: changed,
            },
          }),
        );
      }

      return policy;
    } catch (error) {
      this.logger.error(`Error updating the policy of date ${occurrenceId} of event ${eventId}`, error);
      throw error;
    }
  }

  /**
   * The event's policy, whole, read under this event's update ceiling, with
   * the ceiling for a write to repeat. The route's guard passes anyone holding
   * the grant on any event, so this read comes right after the lock, before
   * anything else is read. A caller it doesn't reach finds no row and gets
   * 403, never a 400 or 404 that tells them what the event holds (#796).
   * Every event is created with its policy row, which goes only with the
   * event, so no row means no grant.
   *
   * The row is whole, whatever the caller may read: a patch is judged against
   * it, and the audit records what it replaced.
   */
  private async readPolicyToUpdate(tx: Prisma.TransactionClient, eventId: string) {
    // eslint-disable-next-line no-restricted-syntax -- the event's one policy row, not a collection read
    const updateCeiling = this.abilityService.getCurrentResourceConditions(ResourceType.EventPolicy, Action.update);
    const row = await tx.eventPolicy.findUnique({
      where: { eventId, AND: updateCeiling },
      include: POLICY_VIEW_INCLUDE,
    });
    assert(row, new ForbiddenException(t('common.forbidden.update')));

    return { updateCeiling, policy: toEventPolicyView(row) };
  }
}
