import { GameAdditionMode, OccurrenceOverrideScope, PlatformType, VoteThresholdType } from '@bge/database';
import { t, type I18nPath } from '@bge/i18n';
import { makeEventOccurrencePolicy } from '@bge/testing';
import {
  assertWithinOverrideScope,
  occurrencesExceedingScope,
  type EventRestrictions,
  type OccurrenceRestrictions,
} from './override-scope';

const { None, TightenOnly, Any } = OccurrenceOverrideScope;

/**
 * An event that allows Tabletop and PC games, on two platforms, in two
 * categories, for up to 8 attendees and 10 in all, strictly.
 */
const restricted: EventRestrictions = {
  allowedPlatformTypes: [PlatformType.PC, PlatformType.Tabletop],
  allowedPlatformIds: ['plat-1', 'plat-2'],
  allowedCategoryIds: ['cat-1', 'cat-2'],
  restrictToGameCategories: true,
  maxAttendees: 8,
  maxTotalParticipants: 10,
  strictCapacity: true,
};

/** An event that restricts nothing. */
const unrestricted: EventRestrictions = {
  allowedPlatformTypes: [],
  allowedPlatformIds: [],
  allowedCategoryIds: [],
  restrictToGameCategories: false,
  maxAttendees: null,
  maxTotalParticipants: null,
  strictCapacity: false,
};

/** A date that keeps the event's restrictions, apart from what it is given. */
const date = (overrides: Partial<OccurrenceRestrictions> = {}): OccurrenceRestrictions => ({
  allowedPlatformTypes: [],
  allowedPlatformIds: [],
  allowedCategoryIds: [],
  restrictToGameCategories: null,
  maxAttendees: null,
  maxTotalParticipants: null,
  strictCapacity: null,
  platformTypesUnrestricted: false,
  platformsUnrestricted: false,
  capacityUnrestricted: false,
  ...overrides,
});

/** A 400 with the code and message given. */
const refusal = (code: string, key: I18nPath) =>
  expect.objectContaining({ status: 400, response: expect.objectContaining({ code, message: t(key) }) });

const refuses = (event: EventRestrictions, occurrence: OccurrenceRestrictions, scope: OccurrenceOverrideScope) =>
  expect(() => assertWithinOverrideScope(event, occurrence, scope)).toThrow(
    refusal('EVENT_OCCURRENCE_OVERRIDE_NOT_ALLOWED', 'errors.event_policy.occurrence_override_not_allowed'),
  );

const allows = (event: EventRestrictions, occurrence: OccurrenceRestrictions, scope: OccurrenceOverrideScope) =>
  expect(() => assertWithinOverrideScope(event, occurrence, scope)).not.toThrow();

describe('assertWithinOverrideScope', () => {
  // Under None the date keeps every restriction the event sets (#796).
  describe('None', () => {
    it.each<[string, Partial<OccurrenceRestrictions>]>([
      ['a platform type list', { allowedPlatformTypes: [PlatformType.Tabletop] }],
      ['a platform list', { allowedPlatformIds: ['plat-1'] }],
      ['a category list', { allowedCategoryIds: ['cat-1'] }],
      ['restricting categories', { restrictToGameCategories: true }],
      ['lifting categories', { restrictToGameCategories: false }],
      ['a lower attendee cap', { maxAttendees: 4 }],
      ['a lower participant cap', { maxTotalParticipants: 4 }],
      ['strict capacity', { strictCapacity: true }],
      ['no platform type restriction', { platformTypesUnrestricted: true }],
      ['no platform restriction', { platformsUnrestricted: true }],
      ['no capacity limit', { capacityUnrestricted: true }],
    ])('refuses %s (#796)', (_, overrides) => {
      refuses(restricted, date(overrides), None);
    });

    // The scope covers the restrictions only: how games are added, voting and
    // participation stay the date's to set (#796).
    it('allows a date that overrides only fields outside the restrictions, such as gameAdditionMode (#796)', () => {
      const row = {
        ...makeEventOccurrencePolicy('occ-1', {
          gameAdditionMode: GameAdditionMode.HostOnly,
          voteThresholdType: VoteThresholdType.Unanimous,
          allowSpectators: false,
        }),
        allowedPlatformTypes: [],
        allowedPlatformIds: [],
        allowedCategoryIds: [],
      };

      allows(restricted, row, None);
    });
  });

  describe('TightenOnly', () => {
    it.each<[string, Partial<OccurrenceRestrictions>]>([
      ['nothing of its own', {}],
      ['a subset of the platform types', { allowedPlatformTypes: [PlatformType.Tabletop] }],
      ['a subset of the platforms', { allowedPlatformIds: ['plat-2'] }],
      ['a subset of the categories', { allowedCategoryIds: ['cat-2'], restrictToGameCategories: true }],
      ['the same lists', { allowedPlatformTypes: [PlatformType.Tabletop, PlatformType.PC] }],
      ['a lower attendee cap', { maxAttendees: 4 }],
      ['the same attendee cap', { maxAttendees: 8 }],
      ['a lower participant cap', { maxTotalParticipants: 9 }],
      ['strict capacity', { strictCapacity: true }],
    ])('allows %s (#796)', (_, overrides) => {
      allows(restricted, date(overrides), TightenOnly);
    });

    it.each<[string, Partial<OccurrenceRestrictions>]>([
      ['a superset of the platform types', { allowedPlatformTypes: [PlatformType.Tabletop, PlatformType.Console] }],
      ['a disjoint platform type list', { allowedPlatformTypes: [PlatformType.Console] }],
      ['a platform outside the list', { allowedPlatformIds: ['plat-1', 'plat-3'] }],
      ['a category outside the list', { allowedCategoryIds: ['cat-3'] }],
      ['a higher attendee cap', { maxAttendees: 9 }],
      ['a higher participant cap', { maxTotalParticipants: 11 }],
      ['no platform type restriction', { platformTypesUnrestricted: true }],
      ['no platform restriction', { platformsUnrestricted: true }],
      ['no capacity limit', { capacityUnrestricted: true }],
    ])('refuses %s (#796)', (_, overrides) => {
      refuses(restricted, date(overrides), TightenOnly);
    });

    // The event is strict and restricts categories, so either "false" lifts
    // a restriction rather than narrowing it (#796).
    it('refuses strictCapacity false under a strict event, and lifting the categories (#796)', () => {
      refuses(restricted, date({ strictCapacity: false }), TightenOnly);
      refuses(restricted, date({ restrictToGameCategories: false }), TightenOnly);
    });

    // An empty list, a null cap and categories left unrestricted are no
    // restriction, so whatever the date sets narrows them (#796).
    it('allows any list, capacity or category setting under an event that restricts nothing (#796)', () => {
      allows(
        unrestricted,
        date({
          allowedPlatformTypes: [PlatformType.Console],
          allowedPlatformIds: ['plat-9'],
          allowedCategoryIds: ['cat-9'],
          restrictToGameCategories: true,
          maxAttendees: 100,
          maxTotalParticipants: 100,
          strictCapacity: false,
        }),
        TightenOnly,
      );
      allows(unrestricted, date({ restrictToGameCategories: false }), TightenOnly);
    });

    // An event restricts categories only when it says so: its list alone
    // doesn't, and a restriction with an empty list allows no category (#796).
    it("reads the event's category restriction from restrictToGameCategories, not from its list (#796)", () => {
      const listOnly = { ...unrestricted, allowedCategoryIds: ['cat-1'] };
      const emptyList = { ...restricted, allowedCategoryIds: [] };

      allows(listOnly, date({ allowedCategoryIds: ['cat-9'], restrictToGameCategories: true }), TightenOnly);
      refuses(emptyList, date({ allowedCategoryIds: ['cat-1'] }), TightenOnly);
    });

    it('still refuses a "no restriction" flag under an event that restricts nothing (#796)', () => {
      refuses(unrestricted, date({ platformTypesUnrestricted: true }), TightenOnly);
      refuses(unrestricted, date({ capacityUnrestricted: true }), TightenOnly);
    });
  });

  describe('Any', () => {
    it.each<[string, Partial<OccurrenceRestrictions>]>([
      ['no platform type restriction', { platformTypesUnrestricted: true }],
      ['no platform restriction', { platformsUnrestricted: true }],
      ['no capacity limit', { capacityUnrestricted: true }],
      ['a disjoint platform type list', { allowedPlatformTypes: [PlatformType.Console] }],
      ['a higher capacity', { maxAttendees: 50, maxTotalParticipants: 60, strictCapacity: false }],
      ['lifting the categories', { restrictToGameCategories: false }],
    ])('allows %s (#796)', (_, overrides) => {
      allows(restricted, date(overrides), Any);
    });

    // A strict date with no cap restricts nothing, so it isn't a contradiction.
    it('allows no capacity limit beside strictCapacity (#796)', () => {
      allows(restricted, date({ capacityUnrestricted: true, strictCapacity: true }), Any);
    });
  });

  // A "no restriction" flag and a list or cap of the same kind can't both
  // hold, whatever the scope, so the date is invalid before it is out of
  // scope (#796).
  describe('a "no restriction" flag beside a restriction of its kind', () => {
    it.each<[string, Partial<OccurrenceRestrictions>, I18nPath]>([
      [
        'platform types',
        { platformTypesUnrestricted: true, allowedPlatformTypes: [PlatformType.Tabletop] },
        'errors.event_policy.platform_types_unrestricted_with_list',
      ],
      [
        'platforms',
        { platformsUnrestricted: true, allowedPlatformIds: ['plat-1'] },
        'errors.event_policy.platforms_unrestricted_with_list',
      ],
      [
        'an attendee cap',
        { capacityUnrestricted: true, maxAttendees: 4 },
        'errors.event_policy.capacity_unrestricted_with_limit',
      ],
      [
        'a participant cap',
        { capacityUnrestricted: true, maxTotalParticipants: 4 },
        'errors.event_policy.capacity_unrestricted_with_limit',
      ],
    ])('refuses %s as an invalid policy under every scope (#796)', (_, overrides, key) => {
      for (const scope of [None, TightenOnly, Any]) {
        expect(() => assertWithinOverrideScope(restricted, date(overrides), scope)).toThrow(
          refusal('EVENT_POLICY_INVALID', key),
        );
      }
    });
  });
});

describe('occurrencesExceedingScope', () => {
  const row = (occurrenceId: string, overrides: Partial<OccurrenceRestrictions> = {}) => ({
    occurrenceId,
    ...date(overrides),
  });

  it('names each date past the scope, in the order given (#796)', () => {
    const rows = [
      row('occ-1', { platformTypesUnrestricted: true }),
      row('occ-2', { allowedPlatformTypes: [PlatformType.Tabletop] }),
      row('occ-3', { maxAttendees: 20 }),
    ];

    expect(occurrencesExceedingScope(restricted, rows, TightenOnly)).toEqual(['occ-1', 'occ-3']);
  });

  it('names none when every date fits (#796)', () => {
    expect(occurrencesExceedingScope(restricted, [row('occ-1'), row('occ-2')], None)).toEqual([]);
    expect(occurrencesExceedingScope(restricted, [row('occ-1', { capacityUnrestricted: true })], Any)).toEqual([]);
  });
});
