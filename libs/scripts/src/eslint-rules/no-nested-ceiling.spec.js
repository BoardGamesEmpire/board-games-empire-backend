'use strict';
/**
 * The rule lives in the root `eslint.config.mjs`, which every project's lint
 * target already hashes, so an edit to it re-lints the whole tree. This spec
 * sits here because this lib is where the repo's CI checks are tested; its
 * `test` target lists the root config as an input for the same reason.
 */
const { RuleTester } = require('eslint');
const tseslint = require('typescript-eslint');

const { bgePlugin } = require('../../../../eslint.config.mjs');

const rule = bgePlugin.rules['no-nested-ceiling'];

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
});

/** Wraps a query's arguments in a service method, the shape every call site has. */
function read(args) {
  return `class EventService {
  async getEvent(id: string) {
    return this.db.event.findUnique(${args});
  }
}`;
}

ruleTester.run('no-nested-ceiling', rule, {
  valid: [
    {
      name: 'a ceiling in the top-level where, beside an include',
      code: read(`{
      where: { id, AND: this.abilityService.getCurrentResourceConditions(ResourceType.Event, Action.read) },
      include: { occurrences: true },
    }`),
    },
    {
      name: 'a composed scope as the whole top-level where, beside a select',
      code: read(`{
      where: this.scopeComposer.compose(ResourceType.Event, Action.read, { householdId }),
      select: { id: true },
    }`),
    },
    {
      name: 'accessibleBy in a top-level AND',
      code: read(`{
      where: { id, AND: [accessibleBy(ability).ofType(ResourceType.Event)] },
      include: { policy: true },
    }`),
    },
    {
      name: 'a relation filter that carries no ceiling',
      code: read(`{
      where: { id },
      include: { invites: { where: { status: InviteStatus.Pending } } },
    }`),
    },
    {
      name: 'a function under a select key reads on its own',
      code: `const handlers = {
  select: () => this.db.event.findMany({ where: this.scopeComposer.compose(ResourceType.Event, Action.read, {}) }),
};`,
    },
    {
      name: 'a bare compose() is a helper, not the scope composer',
      code: read(`{ where: { id }, include: { occurrences: compose(withGames, withVotes) } }`),
    },
    {
      name: "a functional library's compose() is not the scope composer",
      code: read(`{ where: { id }, select: { title: R.compose(trim, String)(raw) } }`),
    },
    {
      name: 'a ceiling in the top-level where of a write, beside its data',
      code: `this.db.eventAttendee.updateMany({
  where: { eventId, AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.update) },
  data: { status },
});`,
    },
    {
      name: 'a scoped read that is itself the value of a data key',
      code: `class EventService {
  async page() {
    return { data: await this.db.event.findMany({ where: this.scopeComposer.compose(ResourceType.Event, Action.read, {}) }) };
  }
}`,
    },
    {
      name: 'a scoped read batched under a select key',
      code: `const select = await this.db.$transaction([
  this.db.event.count({ where: { AND: this.abilityService.getCurrentResourceConditions(ResourceType.Event, Action.read) } }),
]);`,
    },
    {
      name: 'a variable named for something else',
      code: `class EventService {
  async list() {
    const where = this.scopeComposer.compose(ResourceType.Event, Action.read, {});
    const metadata = { scope: this.abilityService.getCurrentResourceConditions(ResourceType.Event, Action.read) };
    return this.db.event.findMany({ where, include: { policy: true } });
  }
}`,
    },
    {
      // The rule sees calls, not values. Its message names this gap.
      name: 'the known gap: a ceiling stored in a variable first',
      code: `class OccurrenceService {
  async list(eventId: string) {
    const votes = this.scopeComposer.compose(ResourceType.EventAvailabilityVote, Action.read, {});
    return this.db.eventOccurrence.findMany({ where: { eventId }, include: { availabilityVotes: { where: votes } } });
  }
}`,
    },
    {
      // The other half of the gap: inside the helper no include or select
      // encloses the call, and at the call site nothing is a ceiling call.
      name: 'the known gap: an include built by a helper',
      code: `class EventService {
  private attendeeInclude() {
    return { attendees: { where: this.scopeComposer.compose(ResourceType.EventAttendee, Action.read, {}) } };
  }

  async getEvent(id: string) {
    return this.db.event.findUnique({ where: { id }, include: this.attendeeInclude() });
  }
}`,
    },
    {
      // The price of ending the search at the nearest call: the rule cannot
      // tell a helper from the ceiling's own query.
      name: 'the known gap: a ceiling passed through a helper call',
      code: read(`{
      where: { id },
      include: { attendees: { where: and(this.scopeComposer.compose(ResourceType.EventAttendee, Action.read, {}), { status }) } },
    }`),
    },
  ],
  invalid: [
    {
      name: 'getCurrentResourceConditions in an include filter',
      code: read(`{
      where: { id },
      include: {
        occurrences: {
          where: { AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventOccurrence, Action.read) },
        },
      },
    }`),
      errors: [{ messageId: 'nestedCeiling', data: { name: 'getCurrentResourceConditions', key: 'include' } }],
    },
    {
      name: "compose in an include filter (the first draft of the availability summary's fix)",
      code: read(`{
      where: { id },
      include: {
        availabilityVotes: {
          where: this.scopeComposer.compose(ResourceType.EventAvailabilityVote, Action.read, { occurrenceId: id }),
        },
      },
    }`),
      errors: [{ messageId: 'nestedCeiling', data: { name: 'compose', key: 'include' } }],
    },
    {
      name: 'getResourceConditionsForAbilities, the explicit-abilities form, in an include filter',
      code: read(`{
      where: { id },
      include: {
        attendees: {
          where: {
            AND: this.abilityService.getResourceConditionsForAbilities(abilities, ResourceType.EventAttendee, Action.read),
          },
        },
      },
    }`),
      errors: [{ messageId: 'nestedCeiling', data: { name: 'getResourceConditionsForAbilities', key: 'include' } }],
    },
    {
      name: "a nested write's filter under data",
      code: `this.db.event.update({
  where: { id },
  data: {
    attendees: {
      updateMany: {
        where: { AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.update) },
        data: { status },
      },
    },
  },
});`,
      errors: [{ messageId: 'nestedCeiling', data: { name: 'getCurrentResourceConditions', key: 'data' } }],
    },
    {
      name: 'compose on a scope composer held in a plain variable',
      code: read(`{
      where: { id },
      include: { occurrences: { where: scopeComposer.compose(ResourceType.EventOccurrence, Action.read, {}) } },
    }`),
      errors: [{ messageId: 'nestedCeiling', data: { name: 'compose', key: 'include' } }],
    },
    {
      name: 'accessibleBy in a nested select filter',
      code: read(`{
      where: { id },
      select: { id: true, attendees: { where: { AND: [accessibleBy(ability).ofType(ResourceType.EventAttendee)] } } },
    }`),
      errors: [{ messageId: 'nestedCeiling', data: { name: 'accessibleBy', key: 'select' } }],
    },
    {
      name: 'a ceiling in a relation count, reported once at the nearest key',
      code: read(`{
      where: { id },
      select: {
        _count: { select: { attendees: { where: this.scopeComposer.compose(ResourceType.EventAttendee, Action.read, {}) } } },
      },
    }`),
      errors: [{ messageId: 'nestedCeiling', data: { name: 'compose', key: 'select' } }],
    },
    {
      name: 'an include nested in an include',
      code: read(`{
      where: { id },
      include: {
        occurrences: {
          include: {
            games: { where: { AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventGame, Action.read) } },
          },
        },
      },
    }`),
      errors: [{ messageId: 'nestedCeiling' }],
    },
    {
      name: 'a ceiling spread into the filter, through a quoted key and an optional call',
      code: read(`{
      where: { id },
      'include': {
        attendees: { where: { AND: [...this.ability?.getCurrentResourceConditions(ResourceType.EventAttendee, Action.read)] } },
      },
    }`),
      errors: [{ messageId: 'nestedCeiling', data: { name: 'getCurrentResourceConditions', key: 'include' } }],
    },
    {
      name: 'an include written as its own constant, behind a type assertion',
      code: `const include = {
  include: { policy: { where: { AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventPolicy, Action.read) } } },
} satisfies Prisma.EventFindUniqueArgs;`,
      errors: [{ messageId: 'nestedCeiling' }],
    },
    {
      name: 'a ceiling used as the receiver of a call, not passed into one',
      code: read(`{
      where: { id },
      include: {
        attendees: {
          where: { AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.read).concat(extra) },
        },
      },
    }`),
      errors: [{ messageId: 'nestedCeiling', data: { name: 'getCurrentResourceConditions', key: 'include' } }],
    },
    {
      name: 'an include built in a variable named include',
      code: `class EventService {
  async list(where) {
    const include = { attendees: { where: this.scopeComposer.compose(ResourceType.EventAttendee, Action.read, {}) } };
    return this.db.event.findMany({ where, include });
  }
}`,
      errors: [{ messageId: 'nestedCeiling', data: { name: 'compose', key: 'include' } }],
    },
    {
      name: 'a select built in a camel-case variable',
      code: `class EventService {
  async get(id) {
    const attendeeSelect = {
      id: true,
      attendees: { where: { AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.read) } },
    };
    return this.db.event.findUnique({ where: { id }, select: attendeeSelect });
  }
}`,
      errors: [{ messageId: 'nestedCeiling', data: { name: 'getCurrentResourceConditions', key: 'attendeeSelect' } }],
    },
    {
      name: 'an include assigned onto the query arguments',
      code: `class EventService {
  async list(args) {
    args.include = { attendees: { where: this.scopeComposer.compose(ResourceType.EventAttendee, Action.read, {}) } };
    return this.db.event.findMany(args);
  }
}`,
      errors: [{ messageId: 'nestedCeiling', data: { name: 'compose', key: 'include' } }],
    },
    {
      name: "a nested write's data built in a constant",
      code: `class EventService {
  async close(id) {
    const UPDATE_DATA = {
      attendees: { deleteMany: { AND: this.abilityService.getCurrentResourceConditions(ResourceType.EventAttendee, Action.delete) } },
    };
    return this.db.event.update({ where: { id }, data: UPDATE_DATA });
  }
}`,
      errors: [{ messageId: 'nestedCeiling', data: { name: 'getCurrentResourceConditions', key: 'UPDATE_DATA' } }],
    },
    {
      name: 'every nested ceiling is reported',
      code: read(`{
      where: { id },
      include: {
        occurrences: { where: this.scopeComposer.compose(ResourceType.EventOccurrence, Action.read, {}) },
        attendees: { where: this.scopeComposer.compose(ResourceType.EventAttendee, Action.read, {}) },
      },
    }`),
      errors: [{ messageId: 'nestedCeiling' }, { messageId: 'nestedCeiling' }],
    },
  ],
});
