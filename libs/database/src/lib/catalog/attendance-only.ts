import { ResourceType } from '../client';

/**
 * The resource types that only event attendance grants (#1543). An event role
 * holds a permission on one, bound to the event attended, and nothing else
 * reaches it: not a server role's read of every type, not a household role,
 * not a direct permission, not a plugin and not an API key. So the Owner, an
 * Admin and a Moderator read an event chat only as its attendees.
 * `AbilityFactory` enforces the list in every ability but the system actor's.
 *
 * A chat reaction's type joins the list when reactions get one (#1548).
 */
export const ATTENDANCE_ONLY_RESOURCE_TYPES: readonly ResourceType[] = [ResourceType.EventChatMessage];

/**
 * Whether `subject` names an attendance-only resource type. It takes a string
 * because that is what a CASL rule's subject and a permission's `subject`
 * column are.
 */
export function isAttendanceOnly(subject: string): boolean {
  const types: readonly string[] = ATTENDANCE_ONLY_RESOURCE_TYPES;

  return types.includes(subject);
}
