import { isCodeVerifier, isS256Challenge, verifierMatchesChallenge } from './pkce';

/** The example pair from RFC 7636, Appendix B. */
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

/** The string with its character at `index` swapped for another the same alphabet allows. */
const changedAt = (value: string, index: number): string =>
  `${value.slice(0, index)}${value[index] === 'A' ? 'B' : 'A'}${value.slice(index + 1)}`;

describe('verifierMatchesChallenge', () => {
  // The app proves it started the sign-in by sending the verifier whose hash
  // it sent as the challenge (#1019).
  it('matches RFC 7636’s example verifier to its challenge (#1019)', () => {
    expect(verifierMatchesChallenge(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
  });

  it.each([
    ['the verifier', changedAt(RFC_VERIFIER, 0), RFC_CHALLENGE],
    ['the challenge', RFC_VERIFIER, changedAt(RFC_CHALLENGE, 42)],
  ])('refuses the pair with one character of %s changed (#1019)', (_part, verifier, challenge) => {
    expect(verifierMatchesChallenge(verifier, challenge)).toBe(false);
  });

  it.each([
    ['a short verifier', RFC_VERIFIER.slice(0, 42), RFC_CHALLENGE],
    ['a short challenge', RFC_VERIFIER, RFC_CHALLENGE.slice(0, 42)],
    ['an empty verifier', '', RFC_CHALLENGE],
    ['a padded challenge', RFC_VERIFIER, `${RFC_CHALLENGE}=`],
  ])('answers false, without throwing, for %s (#1019)', (_case, verifier, challenge) => {
    expect(verifierMatchesChallenge(verifier, challenge)).toBe(false);
  });
});

describe('isS256Challenge', () => {
  it('accepts 43 base64url characters (#1019)', () => {
    expect(isS256Challenge(RFC_CHALLENGE)).toBe(true);
  });

  // A SHA-256 hash is 43 characters in base64url without padding.
  it.each([
    ['42 characters', RFC_CHALLENGE.slice(0, 42)],
    ['44 characters', `${RFC_CHALLENGE}A`],
    ['a +', `${RFC_CHALLENGE.slice(0, 42)}+`],
    ['a /', `${RFC_CHALLENGE.slice(0, 42)}/`],
    ['a =', `${RFC_CHALLENGE.slice(0, 42)}=`],
  ])('refuses %s (#1019)', (_case, challenge) => {
    expect(isS256Challenge(challenge)).toBe(false);
  });
});

describe('isCodeVerifier', () => {
  // RFC 7636 §4.1: 43 to 128 characters of [A-Za-z0-9._~-].
  it.each([
    ['43 characters', 'a'.repeat(43)],
    ['128 characters', 'a'.repeat(128)],
    ['every allowed punctuation mark', `${'a'.repeat(39)}._~-`],
  ])('accepts %s (#1019)', (_case, verifier) => {
    expect(isCodeVerifier(verifier)).toBe(true);
  });

  it.each([
    ['42 characters', 'a'.repeat(42)],
    ['129 characters', 'a'.repeat(129)],
    ['a space', `${'a'.repeat(42)} `],
  ])('refuses %s (#1019)', (_case, verifier) => {
    expect(isCodeVerifier(verifier)).toBe(false);
  });
});
