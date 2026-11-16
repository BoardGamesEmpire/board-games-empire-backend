import type { UpdateEventOccurrenceDto } from '../dto/update-event-occurrence.dto';

/**
 * The columns `PATCH /events/:eventId/occurrences/:occurrenceId` writes. The
 * catalog binds the date's edit permissions to the same list (#979), so the
 * route's guard asks for any one of them, and the write's ceiling for each
 * one sent.
 */
export const OCCURRENCE_EDIT_FIELDS = [
  'label',
  'startDate',
  'endDate',
  'location',
  'sortOrder',
] as const satisfies readonly (keyof UpdateEventOccurrenceDto)[];
