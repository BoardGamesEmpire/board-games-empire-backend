import { OccurrenceOverrideScope, type PlatformType } from '@bge/database';
import { CodedHttpException, t, type I18nPath } from '@bge/i18n';
import { Http } from '@status/codes';

/**
 * The restrictions of an event's policy that its override scope covers
 * (#796): the allowed platform types, platforms and categories, and capacity.
 * An empty platform list or a `null` cap is no restriction of that kind.
 * Categories are restricted only when `restrictToGameCategories` is true,
 * whatever the list holds.
 */
export interface EventRestrictions {
  readonly allowedPlatformTypes: readonly PlatformType[];
  readonly allowedPlatformIds: readonly string[];
  readonly allowedCategoryIds: readonly string[];
  readonly restrictToGameCategories: boolean;
  readonly maxAttendees: number | null;
  readonly maxTotalParticipants: number | null;
  readonly strictCapacity: boolean;
}

/**
 * The same restrictions as a date's own policy sets them (#796). An empty list
 * or `null` keeps the event's. A `*Unrestricted` flag is no restriction of its
 * kind for that date, and `restrictToGameCategories: false` is no category
 * restriction.
 */
export interface OccurrenceRestrictions {
  readonly allowedPlatformTypes: readonly PlatformType[];
  readonly allowedPlatformIds: readonly string[];
  readonly allowedCategoryIds: readonly string[];
  readonly restrictToGameCategories: boolean | null;
  readonly maxAttendees: number | null;
  readonly maxTotalParticipants: number | null;
  readonly strictCapacity: boolean | null;
  readonly platformTypesUnrestricted: boolean;
  readonly platformsUnrestricted: boolean;
  readonly capacityUnrestricted: boolean;
}

const invalid = (key: I18nPath) => new CodedHttpException(Http.BadRequest, 'EVENT_POLICY_INVALID', t(key));

/**
 * Refuses a date's policy that says "no restriction" beside a restriction of
 * the same kind. The two can't both hold, so the policy is invalid whatever the
 * event's scope (#796). `strictCapacity` beside no capacity limit restricts
 * nothing, so it stands.
 */
export function assertOccurrenceRestrictionsConsistent(occurrence: OccurrenceRestrictions): void {
  if (occurrence.platformTypesUnrestricted && occurrence.allowedPlatformTypes.length > 0) {
    throw invalid('errors.event_policy.platform_types_unrestricted_with_list');
  }

  if (occurrence.platformsUnrestricted && occurrence.allowedPlatformIds.length > 0) {
    throw invalid('errors.event_policy.platforms_unrestricted_with_list');
  }

  if (
    occurrence.capacityUnrestricted &&
    (occurrence.maxAttendees !== null || occurrence.maxTotalParticipants !== null)
  ) {
    throw invalid('errors.event_policy.capacity_unrestricted_with_limit');
  }
}

/**
 * Refuses a date's policy that overrides the event's restrictions further than
 * the event's scope lets it (#796):
 *
 * - **None:** the date sets no restriction and no "no restriction" flag.
 * - **TightenOnly:** each list the date sets is within the event's, or the
 *   event has none of that kind; categories stay restricted while the event's
 *   are; each cap is no higher than the event's, or the event has none; a
 *   strict event stays strict; and no flag is set.
 * - **Any:** anything, flags included.
 *
 * A policy that contradicts itself is refused first, as invalid. The scope
 * covers the restrictions alone: how games are added, voting and participation
 * stay the date's to set.
 */
export function assertWithinOverrideScope(
  event: EventRestrictions,
  occurrence: OccurrenceRestrictions,
  scope: OccurrenceOverrideScope,
): void {
  assertOccurrenceRestrictionsConsistent(occurrence);

  if (!isWithinOverrideScope(event, occurrence, scope)) {
    throw new CodedHttpException(
      Http.BadRequest,
      'EVENT_OCCURRENCE_OVERRIDE_NOT_ALLOWED',
      t('errors.event_policy.occurrence_override_not_allowed'),
    );
  }
}

/**
 * The ids of the dates whose policies override the event's restrictions
 * further than the scope lets them, in the order given. An event change that
 * would leave any is refused, so the host changes those dates first rather than
 * losing what they set (#796).
 */
export function occurrencesExceedingScope(
  event: EventRestrictions,
  occurrences: readonly (OccurrenceRestrictions & { readonly occurrenceId: string })[],
  scope: OccurrenceOverrideScope,
): string[] {
  return occurrences
    .filter((occurrence) => !isWithinOverrideScope(event, occurrence, scope))
    .map(({ occurrenceId }) => occurrenceId);
}

function isWithinOverrideScope(
  event: EventRestrictions,
  occurrence: OccurrenceRestrictions,
  scope: OccurrenceOverrideScope,
): boolean {
  switch (scope) {
    case OccurrenceOverrideScope.Any:
      return true;
    case OccurrenceOverrideScope.None:
      return overridesNothing(occurrence);
    case OccurrenceOverrideScope.TightenOnly:
      return onlyNarrows(event, occurrence);
  }
}

function setsNoFlag(occurrence: OccurrenceRestrictions): boolean {
  return !occurrence.platformTypesUnrestricted && !occurrence.platformsUnrestricted && !occurrence.capacityUnrestricted;
}

function overridesNothing(occurrence: OccurrenceRestrictions): boolean {
  return (
    setsNoFlag(occurrence) &&
    occurrence.allowedPlatformTypes.length === 0 &&
    occurrence.allowedPlatformIds.length === 0 &&
    occurrence.allowedCategoryIds.length === 0 &&
    occurrence.restrictToGameCategories === null &&
    occurrence.maxAttendees === null &&
    occurrence.maxTotalParticipants === null &&
    occurrence.strictCapacity === null
  );
}

function onlyNarrows(event: EventRestrictions, occurrence: OccurrenceRestrictions): boolean {
  return (
    setsNoFlag(occurrence) &&
    narrowsList(event.allowedPlatformTypes, occurrence.allowedPlatformTypes) &&
    narrowsList(event.allowedPlatformIds, occurrence.allowedPlatformIds) &&
    narrowsCategories(event, occurrence) &&
    narrowsCap(event.maxAttendees, occurrence.maxAttendees) &&
    narrowsCap(event.maxTotalParticipants, occurrence.maxTotalParticipants) &&
    !(event.strictCapacity && occurrence.strictCapacity === false)
  );
}

/** An empty platform list is no restriction, so anything narrows it, and an empty date list keeps the event's. */
function narrowsList<T>(eventList: readonly T[], occurrenceList: readonly T[]): boolean {
  return eventList.length === 0 || occurrenceList.every((member) => eventList.includes(member));
}

/**
 * While the event restricts categories, the date can't lift the restriction,
 * and its list stays within the event's. An empty event list then allows no
 * category, so no date list fits it. While the event doesn't, anything the
 * date sets narrows.
 */
function narrowsCategories(event: EventRestrictions, occurrence: OccurrenceRestrictions): boolean {
  if (!event.restrictToGameCategories) {
    return true;
  }

  return (
    occurrence.restrictToGameCategories !== false &&
    occurrence.allowedCategoryIds.every((categoryId) => event.allowedCategoryIds.includes(categoryId))
  );
}

/** A `null` event cap is no limit, so any date cap narrows it, and a `null` date cap keeps the event's. */
function narrowsCap(eventCap: number | null, occurrenceCap: number | null): boolean {
  return eventCap === null || occurrenceCap === null || occurrenceCap <= eventCap;
}
