import { Action, ResourceType, type Prisma } from '@bge/database';
import type { AbilityService } from '@bge/permissions';
import { EVENT_POLICY_VIEW_INCLUDE, toEventPolicyView, type EventPolicyView } from './policy-view';

/**
 * The query for an event's policy under the `read:event_policy` ceiling, with
 * the lists embedded. The ceiling goes in the top-level `where`, the one place a
 * deny-all ceiling is enforced (#559).
 *
 * Exposed for a read that runs in a batch (`getEventById`'s REPEATABLE READ
 * batch), which takes a query and not a result. Every other read goes through
 * `readEventPolicyView`.
 */
export function eventPolicyReadArgs(abilityService: AbilityService, eventId: string) {
  return {
    where: {
      eventId,
      // eslint-disable-next-line no-restricted-syntax -- the event's one policy row, not a collection read
      AND: abilityService.getCurrentResourceConditions(ResourceType.EventPolicy, Action.read),
    },
    include: EVENT_POLICY_VIEW_INCLUDE,
  } satisfies Prisma.EventPolicyFindUniqueArgs;
}

/**
 * An event's policy as the actor may read it, or `null` when the ceiling hides
 * it. The one place the read ceiling is applied to the policy, so the policy
 * every route answers with is cut the same way (#796). Pass the transaction
 * client when the read must see the same snapshot as the write or reads around
 * it.
 */
export async function readEventPolicyView(
  client: Pick<Prisma.TransactionClient, 'eventPolicy'>,
  abilityService: AbilityService,
  eventId: string,
): Promise<EventPolicyView | null> {
  const row = await client.eventPolicy.findUnique(eventPolicyReadArgs(abilityService, eventId));

  return row ? toEventPolicyView(row) : null;
}
