import { PERMISSION_CATALOG } from '@bge/database';
import { EVENT_PATCH_FIELDS } from './event-patch-fields.constant';

describe('EVENT_PATCH_FIELDS', () => {
  // The route's guard and the write's ceiling ask about these columns, and the
  // catalog binds the edit permissions to its own copy. A column on one list
  // and not the other would refuse every PATCH sending it, or let one through
  // that the route never meant to (#1295). `UpdateEventDto` is pinned to the
  // list at compile time, in the constant's file.
  it.each(['update:event', 'update:event:household'])('names the columns %s is bound to', (slug) => {
    const fields = PERMISSION_CATALOG.find((entry) => entry.slug === slug)?.fields;

    expect([...(fields ?? [])].sort()).toEqual([...EVENT_PATCH_FIELDS].sort());
  });
});
