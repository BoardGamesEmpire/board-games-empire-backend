import type { UpdateEventDto } from '../dto/update-event.dto';

/**
 * The columns `PATCH /events/:id` writes. The catalog binds the event's edit
 * permissions to the same list (#795), so the route's guard asks for any one
 * of them, and the write's ceiling for each one sent (#1295).
 */
export const EVENT_PATCH_FIELDS = [
  'title',
  'description',
  'image',
  'location',
  'url',
  'type',
  'reach',
  'schedulingMode',
] as const satisfies readonly (keyof UpdateEventDto)[];

/**
 * Compile-time guard for the other direction: a property added to
 * `UpdateEventDto` and left out of the list makes `_UnlistedPatchField` stop
 * being `never`, and this assignment fails, naming it. Left out, no edit
 * permission would cover it, so every PATCH sending it would answer 403.
 */
type _UnlistedPatchField = Exclude<keyof UpdateEventDto, (typeof EVENT_PATCH_FIELDS)[number]>;
const _assertEveryPatchFieldListed: [_UnlistedPatchField] extends [never]
  ? true
  : { readonly __unlistedPatchFields: _UnlistedPatchField } = true;
void _assertEveryPatchFieldListed;
