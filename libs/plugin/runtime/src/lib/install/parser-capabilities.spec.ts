import { PARSER_CAPABILITY_PROBES, probeParserCapabilities, resolvedParserVersion } from './parser-capabilities';

/**
 * Runs against the REAL resolved meriyah — no mock — so this suite IS the
 * dev-tree half of #219's resolution verification: if hoisting ever
 * regresses (the root pin removed, a conflicting transitive winning the
 * root slot again), CI fails here naming the version it actually resolved,
 * instead of the failure surfacing as refused plugin installs in a deployed
 * instance. The pruned production tree inherits its placement from the same
 * lockfile, so keeping this green keeps both trees honest.
 */
describe('parser capabilities', () => {
  it('the resolved meriyah passes every capability probe', () => {
    expect(probeParserCapabilities()).toEqual([]);
  });

  it('the resolved meriyah is at least the pinned major — the #219 tripwire', () => {
    const version = resolvedParserVersion();
    const [major] = version.split('.');

    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    // >= rather than === so a deliberate future major bump does not trip
    // this spec; the capability probes above are the actual contract, this
    // assertion exists to name a DOWNGRADE for what it is.
    expect(Number(major)).toBeGreaterThanOrEqual(7);
  });

  it('probe capability names are unique, stable identifiers', () => {
    const names = PARSER_CAPABILITY_PROBES.map((probe) => probe.capability);

    expect(new Set(names).size).toBe(names.length);

    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});
