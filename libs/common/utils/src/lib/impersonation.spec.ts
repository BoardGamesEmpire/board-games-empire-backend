import { sessionImpersonatorId, UNKNOWN_IMPERSONATOR } from './impersonation.js';

describe('sessionImpersonatorId', () => {
  it('returns the acting admin id for an impersonated session', () => {
    expect(sessionImpersonatorId({ session: { impersonatedBy: 'admin-1' } })).toBe('admin-1');
  });

  describe('not impersonated', () => {
    it('returns null when the column is SQL NULL', () => {
      expect(sessionImpersonatorId({ session: { impersonatedBy: null } })).toBeNull();
    });

    it('returns null when the field is absent', () => {
      expect(sessionImpersonatorId({ session: {} })).toBeNull();
    });

    it.each([null, undefined])('returns null for a %s session', (session) => {
      expect(sessionImpersonatorId(session)).toBeNull();
    });

    it('returns null when the session envelope has no session row', () => {
      expect(sessionImpersonatorId({ session: null })).toBeNull();
    });
  });

  /**
   * Presence of the column is the marker, not its content. Only
   * `/admin/impersonate-user` writes it, so no legitimate path produces an
   * empty string — and reading one as "not impersonated" would fail OPEN at
   * every actor seam, admitting exactly the session the guard exists to
   * refuse. The callers test the result for truthiness, so the refusal has to
   * survive as a truthy value rather than collapsing to null.
   */
  describe('present but unusable', () => {
    it('treats an empty string as impersonated, not as absent', () => {
      expect(sessionImpersonatorId({ session: { impersonatedBy: '' } })).toBe(UNKNOWN_IMPERSONATOR);
    });

    it('yields a truthy value so the seams still refuse', () => {
      expect(sessionImpersonatorId({ session: { impersonatedBy: '' } })).toBeTruthy();
    });
  });
});
