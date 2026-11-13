import {
  Action,
  DatabaseService,
  isPrismaDependentRecordNotFoundError,
  ResourceType,
  type EventPolicy,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService } from '@bge/permissions';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import assert from 'node:assert';
import { lockLiveEvent } from '../utils/lock-live-event.util';
import { changedKeys, pickSnapshot } from '../utils/pick-snapshot.util';
import type { UpdateEventPolicyDto } from './dto/update-event-policy.dto';
import { EventPolicyUpdatedEvent } from './events/event-policy.events';
import { assertValidVotingRules, foldPolicy } from './policy-rules';

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
   * and admins, both enforced as the ceiling on the write. An organizer may
   * edit the event but not its policy.
   *
   * The write takes the event's lock first, which date writes take too, so the
   * stored policy and the dates' overrides it is judged against can't change
   * before it lands, and a deleted event answers 404. It is judged as the
   * policy it leaves: the stored row with the patch over it, and that folded
   * under each date's overrides, since a date that sets only a threshold type
   * relies on the event's value.
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
      const { existing, updated, policy } = await this.db.$transaction(async (tx) => {
        await lockLiveEvent(tx, eventId);

        // The whole row, whatever the caller may read: the patch is judged
        // against it, and the audit records what it replaced. Every event is
        // created with its policy row, which goes only with the event.
        const existing = await tx.eventPolicy.findUnique({ where: { eventId } });
        assert(existing, new NotFoundException(t('errors.event.not_found', { id: eventId })));

        const datePolicies = await tx.eventOccurrencePolicy.findMany({ where: { occurrence: { eventId } } });

        const merged = { ...existing, ...dto };
        assertValidVotingRules(merged);
        for (const datePolicy of datePolicies) {
          assertValidVotingRules(foldPolicy(merged, datePolicy));
        }

        const updated = await tx.eventPolicy.update({
          where: {
            eventId,
            // eslint-disable-next-line no-restricted-syntax -- the event's one policy row, not a collection read
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventPolicy, Action.update),
          },
          data: dto,
        });

        const policy = await tx.eventPolicy.findUnique({
          where: {
            eventId,
            // eslint-disable-next-line no-restricted-syntax -- the event's one policy row, not a collection read
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventPolicy, Action.read),
          },
        });

        return { existing, updated, policy };
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
