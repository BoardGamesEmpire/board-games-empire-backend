import { mergeProviderClaims, type MergedProviderClaims, type ProviderProfile } from './provider-claims';

const SUB = 'subject-1';
const EMAIL = 'ada@example.org';

/** The merged profile, or a loud failure when the merge answered something else. */
function profileOf(merged: MergedProviderClaims): ProviderProfile {
  if (merged.outcome !== 'profile') {
    throw new Error(`expected a profile, got ${merged.outcome}`);
  }

  return merged.profile;
}

describe('mergeProviderClaims', () => {
  it('takes email_verified from UserInfo when the ID token leaves it out (#993)', () => {
    const merged = mergeProviderClaims({ sub: SUB, email: EMAIL }, { sub: SUB, email: EMAIL, email_verified: true });

    expect(merged).toMatchObject({ outcome: 'profile', userInfoSetAside: false });
    expect(profileOf(merged).emailVerified).toBe(true);
  });

  it("takes the ID token's claim where both give one, and fills the gaps from UserInfo (#993)", () => {
    const profile = profileOf(
      mergeProviderClaims(
        { sub: SUB, email: EMAIL, name: 'Ada' },
        { sub: SUB, name: 'Ada L.', preferred_username: 'ada' },
      ),
    );

    expect(profile.name).toBe('Ada');
    expect(profile['preferred_username']).toBe('ada');
    expect(profile['sub']).toBe(SUB);
  });

  // OpenID Connect Core 5.3.2: the UserInfo `sub` must match the ID token's,
  // or none of UserInfo's claims may be used.
  it('refuses a UserInfo answer for another subject (#993)', () => {
    expect(mergeProviderClaims({ sub: SUB, email: EMAIL }, { sub: 'subject-2', email: EMAIL })).toEqual({
      outcome: 'subject-mismatch',
    });
  });

  // Some providers send UserInfo's `sub` as a JSON number. Before #993 an ID
  // token with an email skipped UserInfo, so such a provider signed users in;
  // the same identifier, typed differently, isn't another subject.
  it("counts a numeric UserInfo sub that reads as the ID token's (#993)", () => {
    const merged = mergeProviderClaims(
      { sub: '12345', email: EMAIL },
      { sub: 12345, email: EMAIL, email_verified: true },
    );

    expect(merged).toMatchObject({ outcome: 'profile', userInfoSetAside: false });
    expect(profileOf(merged)).toMatchObject({ sub: '12345', emailVerified: true });
  });

  it('refuses a numeric UserInfo sub that reads as another subject (#993)', () => {
    expect(mergeProviderClaims({ sub: '12345', email: EMAIL }, { sub: 12346, email: EMAIL })).toEqual({
      outcome: 'subject-mismatch',
    });
  });

  // A JSON number past Number.MAX_SAFE_INTEGER is rounded when the answer is
  // parsed, so 9007199254740993 arrives as 9007199254740992. The text it reads
  // as can then name another subject, or miss the user's own, so it can't be
  // compared: the answer is set aside, not counted and not refused.
  it.each([
    ['another subject', '9007199254740992'],
    ["the user's own subject", '9007199254740993'],
  ])('sets aside a numeric UserInfo sub too large to read exactly, when the ID token names %s (#993)', (_name, sub) => {
    const userInfo = JSON.parse(`{"sub":9007199254740993,"email":"${EMAIL}","email_verified":true}`);

    const merged = mergeProviderClaims({ sub, email: EMAIL }, userInfo);

    expect(merged).toMatchObject({ outcome: 'profile', userInfoSetAside: true });
    expect(profileOf(merged)).toMatchObject({ sub, emailVerified: false });
  });

  it.each([undefined, null, ''])('sets aside a UserInfo answer with no subject: %p (#993)', (sub) => {
    const merged = mergeProviderClaims({ sub: SUB, email: EMAIL }, { sub, email: EMAIL, email_verified: true });

    expect(merged).toMatchObject({ outcome: 'profile', userInfoSetAside: true });
    expect(profileOf(merged).emailVerified).toBe(false);
  });

  it("doesn't count a confirmation for another email (#993)", () => {
    const profile = profileOf(
      mergeProviderClaims({ sub: SUB, email: EMAIL }, { sub: SUB, email: 'other@example.org', email_verified: true }),
    );

    expect(profile.email).toBe(EMAIL);
    expect(profile.emailVerified).toBe(false);
  });

  it('counts a confirmation whose email differs only in case (#993)', () => {
    const profile = profileOf(
      mergeProviderClaims({ sub: SUB, email: EMAIL }, { sub: SUB, email: 'Ada@Example.org', email_verified: true }),
    );

    expect(profile.emailVerified).toBe(true);
  });

  it.each(['true', 1, 'yes'])('counts only the boolean true: %p (#993)', (emailVerified) => {
    const profile = profileOf(
      mergeProviderClaims({ sub: SUB, email: EMAIL }, { sub: SUB, email: EMAIL, email_verified: emailVerified }),
    );

    expect(profile.emailVerified).toBe(false);
  });

  it('answers UserInfo alone when there is no ID token, as before (#993)', () => {
    const profile = profileOf(
      mergeProviderClaims(undefined, {
        sub: SUB,
        email: EMAIL,
        email_verified: true,
        picture: 'https://p.example/a.png',
      }),
    );

    expect(profile.emailVerified).toBe(true);
    expect(profile.image).toBe('https://p.example/a.png');
  });

  it('treats an ID token without a subject as none (#993)', () => {
    const profile = profileOf(mergeProviderClaims({ email: EMAIL }, { sub: SUB, email: EMAIL }));

    expect(profile['sub']).toBe(SUB);
  });

  // A claim the ID token gives as null or empty text says nothing, so it
  // doesn't hide the value UserInfo gives, as better-auth's own reading
  // didn't for the email.
  it.each([null, ''])('lets UserInfo fill a claim the ID token gives as %p (#993)', (blank) => {
    const profile = profileOf(
      mergeProviderClaims(
        { sub: SUB, email: blank, preferred_username: blank },
        { sub: SUB, email: EMAIL, email_verified: true, preferred_username: 'ada' },
      ),
    );

    expect(profile.email).toBe(EMAIL);
    expect(profile.emailVerified).toBe(true);
    expect(profile['preferred_username']).toBe('ada');
  });

  it('answers none with neither source (#993)', () => {
    expect(mergeProviderClaims(undefined, undefined)).toEqual({ outcome: 'none' });
  });

  it('takes the email from UserInfo when the ID token has none (#993)', () => {
    const profile = profileOf(mergeProviderClaims({ sub: SUB }, { sub: SUB, email: EMAIL, email_verified: true }));

    expect(profile.email).toBe(EMAIL);
    expect(profile.emailVerified).toBe(true);
  });
});
