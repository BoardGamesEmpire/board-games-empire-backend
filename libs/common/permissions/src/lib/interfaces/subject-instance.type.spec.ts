import { ResourceType } from '@bge/database';
import type { ModelResourceType } from './model-resource-type.type';
import type { SubjectInstance } from './subject-instance.type';

// Type tests, as in `permission-entry.spec.ts`: each negative is an
// `@ts-expect-error` that `permissions:typecheck` enforces, since an unused
// directive is itself a compile error. Jest transpiles with SWC and checks
// nothing, so it only confirms they run. The positive case at scale is every
// `assertCurrentActorCan` call site, which compiles against this type (#456).
const instance = <TResource extends ModelResourceType>(_type: TResource, value: SubjectInstance<TResource>) => value;

describe('SubjectInstance', () => {
  it('accepts scalars, nested relations, a null optional relation and a to-many array', () => {
    instance(ResourceType.EventGame, {
      eventId: null,
      event: null,
      occurrence: { id: 'occ-1', eventId: 'ev-1', event: { householdId: null } },
    });
    instance(ResourceType.EventAttendee, { eventId: 'ev-1', role: { role: { name: 'EventGuest' } } });
    instance(ResourceType.Household, { id: 'hh-1', members: [{ userId: 'user-1' }] });
  });

  it('rejects a key the model does not have', () => {
    // @ts-expect-error -- the column is `householdId`
    instance(ResourceType.Event, { household_id: 'hh-1' });
  });

  it('rejects a key the related model does not have', () => {
    instance(ResourceType.EventOccurrence, {
      eventId: 'ev-1',
      // @ts-expect-error -- the column on Event is `householdId`
      event: { household_id: 'hh-1' },
    });
  });

  it('rejects null for a required relation, and one row for a to-many relation', () => {
    // @ts-expect-error -- every event has a creator
    instance(ResourceType.Event, { createdBy: null });
    // @ts-expect-error -- an event has many attendees
    instance(ResourceType.Event, { attendees: { userId: 'user-1' } });
  });

  it('rejects a value its column cannot hold', () => {
    // @ts-expect-error -- `status` is an EventStatus
    instance(ResourceType.Event, { status: 'Adjourned' });
  });
});
