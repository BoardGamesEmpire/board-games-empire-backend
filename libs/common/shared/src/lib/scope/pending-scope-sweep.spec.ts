import { PENDING_SCOPE_SWEEP } from './pending-scope-sweep.js';

/**
 * Pins the unswept set exactly, so it can only ever shrink on purpose.
 *
 * An entry REMOVED here is the sweep making progress and this test is expected
 * to be updated with it. An entry ADDED is a newly written collection read that
 * takes the caller's ceiling as its scope — the defect 365 exists to remove —
 * and the failure is the point: it forces the author to either scope the read
 * or argue in review for the exemption.
 */
describe('PENDING_SCOPE_SWEEP', () => {
  const EXPECTED = [
    'AuditLog',
    'Event',
    'EventGameNomination',
    'EventOccurrence',
    'Friendship',
    'Game',
    'GameCollection',
    'GameGateway',
    'Household',
    'HouseholdMember',
    'Job',
    'MediaContribution',
    'MediaObject',
    'Plugin',
    'User',
  ];

  it('contains exactly the reads not yet moved onto the invariant', () => {
    expect([...PENDING_SCOPE_SWEEP].sort()).toEqual(EXPECTED);
  });

  it('is empty only when the sweep is done, at which point the guard branch goes too', () => {
    // A reminder rather than an assertion about behaviour: when this count
    // reaches zero, delete this file and the PENDING_SCOPE_SWEEP branch in
    // assertListScopeComposed.
    expect(PENDING_SCOPE_SWEEP.size).toBe(EXPECTED.length);
  });
});
