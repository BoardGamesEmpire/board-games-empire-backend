import {
  Action,
  DatabaseService,
  isPrismaDependentRecordNotFoundError,
  ResourceType,
  type EventPolicy,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService } from '@bge/permissions';
import { webhookEnvelope, WebhookEventType } from '@bge/webhooks';
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import assert from 'node:assert';
import { eventWebhookIds } from '../event.service';
import { lockLiveEvent } from '../utils/lock-live-event.util';
import { changedKeys, pickSnapshot } from '../utils/pick-snapshot.util';
import type { UpdateEventPolicyDto } from './dto/update-event-policy.dto';
import { assertValidVotingPolicy, foldPolicy } from './effective-policy';
import { EventPolicyUpdatedEvent } from './events/event-policy.events';

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
   * Work in flight is left as it is. An open nomination finishes the process it
   * started in, a resolve uses the policy in force when it runs, and a voting
   * deadline already set stays.
   *
   * The answer is the row read back under the read ceiling, so a writer who may
   * change the policy but not read it gets `null`. Only the columns whose values
   * changed are audited, and a patch that changes none emits nothing (#728).
   */
  async updatePolicy(eventId: string, dto: UpdateEventPolicyDto): Promise<EventPolicy | null> {
    const initiatedAt = new Date();
    assert(Object.keys(dto).length > 0, new BadRequestException(t('common.at_least_one_field')));

    try {
      const { event, existing, updated, policy } = await this.db.$transaction(async (tx) => {
        const event = await lockLiveEvent(tx, eventId);

        // The route's guard passes anyone holding the grant on any event, so
        // the policy is read under this event's update ceiling before anything
        // else is read. A caller it doesn't reach finds no row and gets 403,
        // never a 400 that tells them what the stored policy holds (#796).
        // Every event is created with its policy row, which goes only with the
        // event, so no row means no grant. The write repeats the ceiling.
        //
        // The row is whole, whatever the caller may read: the patch is judged
        // against it, and the audit records what it replaced.
        // eslint-disable-next-line no-restricted-syntax -- the event's one policy row, not a collection read
        const updateCeiling = this.abilityService.getCurrentResourceConditions(ResourceType.EventPolicy, Action.update);
        const existing = await tx.eventPolicy.findUnique({ where: { eventId, AND: updateCeiling } });
        assert(existing, new ForbiddenException(t('common.forbidden.update')));

        const datePolicies = await tx.eventOccurrencePolicy.findMany({ where: { occurrence: { eventId } } });

        const merged = { ...existing, ...dto };
        assertValidVotingPolicy(merged);
        for (const datePolicy of datePolicies) {
          assertValidVotingPolicy(foldPolicy(merged, datePolicy));
        }

        const updated = await tx.eventPolicy.update({ where: { eventId, AND: updateCeiling }, data: dto });

        const policy = await tx.eventPolicy.findUnique({
          where: {
            eventId,
            // eslint-disable-next-line no-restricted-syntax -- the event's one policy row, not a collection read
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventPolicy, Action.read),
          },
        });

        return { event, existing, updated, policy };
      });

      const changed = changedKeys(existing, updated, Object.keys(dto) as (keyof EventPolicy)[]);
      if (changed.length > 0) {
        this.eventEmitter.emit(
          EventPolicyUpdatedEvent.eventName,
          new EventPolicyUpdatedEvent(
            pickSnapshot(existing, changed),
            pickSnapshot(updated, changed),
            eventId,
            initiatedAt,
          ),
        );

        // Their names, never their values: `data` is copied verbatim to a URL
        // the subscriber controls, and a receiver reads the values with its
        // own credentials. No occurrenceId, as for `updateEvent` (#796).
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
}
