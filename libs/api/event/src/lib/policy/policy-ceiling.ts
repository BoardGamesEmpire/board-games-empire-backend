import { Action, ResourceType, type Prisma } from '@bge/database';
import type { AbilityService } from '@bge/permissions';
import {
  POLICY_VIEW_INCLUDE,
  toEventPolicyView,
  toOccurrencePolicyView,
  type EventPolicyRow,
  type EventPolicyView,
  type OccurrencePolicyRow,
  type OccurrencePolicyView,
} from './policy-view';

/**
 * The query for an event's policy under the `read:event_policy` ceiling, with
 * the lists embedded. The ceiling goes in the top-level `where`, the one place a
 * deny-all ceiling is enforced (#559), and this is the one place the policy's
 * read ceiling is written, so the policy every route answers with is cut the
 * same way (#796).
 *
 * Exposed for a read that runs in a batch, which takes a query and not a
 * result: `getEventById`'s REPEATABLE READ batch and the create replay's.
 * Every other read goes through `readEventPolicyView`.
 */
export function eventPolicyReadArgs(abilityService: AbilityService, eventId: string) {
  return {
    where: {
      eventId,
      // eslint-disable-next-line no-restricted-syntax -- the event's one policy row, not a collection read
      AND: abilityService.getCurrentResourceConditions(ResourceType.EventPolicy, Action.read),
    },
    include: POLICY_VIEW_INCLUDE,
  } satisfies Prisma.EventPolicyFindUniqueArgs;
}

/** A policy row read under the ceiling, as it is served: `null` when the ceiling hid it. */
export function toEventPolicyViewOrNull(row: EventPolicyRow | null): EventPolicyView | null {
  return row ? toEventPolicyView(row) : null;
}

/**
 * An event's policy as the actor may read it, or `null` when the ceiling hides
 * it, read with `eventPolicyReadArgs`. Pass the transaction client when the
 * read must see the same snapshot as the write or reads around it.
 */
export async function readEventPolicyView(
  client: Pick<Prisma.TransactionClient, 'eventPolicy'>,
  abilityService: AbilityService,
  eventId: string,
): Promise<EventPolicyView | null> {
  return toEventPolicyViewOrNull(await client.eventPolicy.findUnique(eventPolicyReadArgs(abilityService, eventId)));
}

/**
 * Whether the actor may read the event's policy, under the same ceiling. A
 * date's own policy is the event's with overrides, and has no read permission
 * of its own, so this is its ceiling too: a caller it answers `false` for is
 * served a date's policy as `null` (#796, #1211).
 */
export async function canReadEventPolicy(
  client: Pick<Prisma.TransactionClient, 'eventPolicy'>,
  abilityService: AbilityService,
  eventId: string,
): Promise<boolean> {
  const { where } = eventPolicyReadArgs(abilityService, eventId);

  return (await client.eventPolicy.count({ where })) > 0;
}

/**
 * A date's own policy as it is served (#796, #1211): its row as a view, or
 * `null` when the actor may not read the event's policy or the date has no
 * policy row. A date's policy is the event's with overrides and has no read
 * permission of its own, so the event policy's read ceiling is its ceiling.
 * `canReadPolicy` is that ceiling's answer for the date's event, from
 * {@link canReadEventPolicy} or a read with {@link eventPolicyReadArgs}.
 */
export function serveOccurrencePolicy(
  row: OccurrencePolicyRow | null,
  canReadPolicy: boolean,
): OccurrencePolicyView | null {
  return canReadPolicy && row ? toOccurrencePolicyView(row) : null;
}

/**
 * The dates' own policies of one event, each served as
 * {@link serveOccurrencePolicy} serves one: `[]` when the actor may not read
 * the event's policy.
 */
export function serveOccurrencePolicies(
  rows: readonly OccurrencePolicyRow[],
  canReadPolicy: boolean,
): OccurrencePolicyView[] {
  return canReadPolicy ? rows.map(toOccurrencePolicyView) : [];
}
