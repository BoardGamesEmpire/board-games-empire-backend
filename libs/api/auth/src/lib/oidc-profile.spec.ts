import { mapOidcProfile } from './oidc-profile';

describe('mapOidcProfile', () => {
  it('takes the username from preferred_username (#912)', () => {
    expect(mapOidcProfile({ preferred_username: 'jason', name: 'Jason F', email: 'j@x.io' })).toMatchObject({
      name: 'jason',
    });
  });

  // A name better-auth finds missing redirects the sign-in with
  // `name_is_missing`, so the email's local part is the last resort (#912).
  it.each([
    [{ name: 'Jason F', email: 'j@x.io' }, 'Jason F'],
    [{ preferred_username: '  ', name: ' ', email: 'jf@x.io' }, 'jf'],
    [{ email: 'jf@x.io' }, 'jf'],
    [{ email: 'a@b@x.io' }, 'a@b'],
  ])('falls back for the username: %p -> %p (#912)', (profile, name) => {
    expect(mapOidcProfile(profile).name).toBe(name);
  });

  // Rather than a name cut from a mangled address, such as `jf` losing its
  // last character to a missing `@` (#912).
  it.each([{ email: 'jf' }, { email: '@x.io' }])(
    'takes no username from an email with no @, or nothing before it: %p (#912)',
    (profile) => {
      expect(mapOidcProfile(profile)).not.toHaveProperty('name');
    },
  );

  // better-auth maps `picture` to `image` itself.
  it('maps given_name and family_name, leaves out the ones not sent, and leaves picture to better-auth (#912)', () => {
    expect(mapOidcProfile({ preferred_username: 'j', given_name: 'Jason', email: 'j@x.io' })).toEqual({
      name: 'j',
      firstName: 'Jason',
    });
    expect(
      mapOidcProfile({
        preferred_username: 'j',
        given_name: 'Jason',
        family_name: 'F',
        picture: 'https://p.example/a.png',
        email: 'j@x.io',
      }),
    ).toEqual({ name: 'j', firstName: 'Jason', lastName: 'F' });
  });

  it('treats a claim that is not a string as absent (#912)', () => {
    expect(mapOidcProfile({ preferred_username: 5, given_name: {}, email: 'j@x.io' })).toEqual({ name: 'j' });
  });
});
