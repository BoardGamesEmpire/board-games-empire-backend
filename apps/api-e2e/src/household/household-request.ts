import type { SystemRole } from '@bge/database';
import type { AuthenticatedActor } from '@bge/testing-e2e';
import request from 'supertest';

/**
 * Request construction for the household member routes, shared by the suites
 * that drive them. Request BUILDING lives here; response PARSING lives in
 * `household-wire.ts`, the split `event/event-request.ts` makes.
 *
 * Seven suites built the remove, leave and transfer URLs themselves, four
 * through a local helper and three inline, and `household-member-removal.spec.ts`
 * would have added another (#273). Five built the role change themselves,
 * four inline and one through a local helper, and moved onto
 * {@link MemberClient.changeRole} with the suite that drives it (#760).
 * Roster reads have no helper yet; their suites build on
 * {@link membersPath}. Each helper returns the supertest chain, so callers
 * keep `.expect()`.
 */

const HOUSEHOLDS_PATH = '/api/households';

export const membersPath = (householdId: string): string => `${HOUSEHOLDS_PATH}/${householdId}/members`;

export interface MemberClient {
  /** `DELETE …/members/:memberId` as `actor`. */
  removeMember(actor: AuthenticatedActor, householdId: string, memberId: string): request.Test;

  /** `DELETE …/members/me` as `actor`: the actor leaves the household. */
  leave(actor: AuthenticatedActor, householdId: string): request.Test;

  /** `POST …/members/:memberId/transfer-ownership` as `actor`. */
  transferOwnership(actor: AuthenticatedActor, householdId: string, memberId: string): request.Test;

  /**
   * `PATCH …/members/:memberId/role` as `actor`, asking for `role`. It takes
   * any `SystemRole`, the household owner role included, so a test can send
   * one the route refuses.
   */
  changeRole(actor: AuthenticatedActor, householdId: string, memberId: string, role: SystemRole): request.Test;
}

export function createMemberClient(baseUrl: string): MemberClient {
  return {
    removeMember: (actor, householdId, memberId) =>
      request(baseUrl)
        .delete(`${membersPath(householdId)}/${memberId}`)
        .set(actor.headers),

    leave: (actor, householdId) =>
      request(baseUrl)
        .delete(`${membersPath(householdId)}/me`)
        .set(actor.headers),

    transferOwnership: (actor, householdId, memberId) =>
      request(baseUrl)
        .post(`${membersPath(householdId)}/${memberId}/transfer-ownership`)
        .set(actor.headers),

    changeRole: (actor, householdId, memberId, role) =>
      request(baseUrl)
        .patch(`${membersPath(householdId)}/${memberId}/role`)
        .set(actor.headers)
        .send({ role }),
  };
}
