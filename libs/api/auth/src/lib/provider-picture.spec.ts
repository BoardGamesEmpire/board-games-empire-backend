import { providerPictureOnly } from './provider-picture';

const PICTURE = 'https://provider.example/a.png';

describe('providerPictureOnly (databaseHooks.user.create.before)', () => {
  // A sign-in provider vouches for these pictures: the OAuth callbacks, an ID
  // token sent to social sign-in, and Google One Tap.
  it.each(['/callback/:id', '/oauth2/callback/:providerId', '/sign-in/social', '/one-tap/callback'])(
    "keeps the provider's picture from %s",
    (path) => {
      expect(providerPictureOnly({ image: PICTURE }, { path })).toBeUndefined();
    },
  );

  // Email sign-up takes `image` from the request body, so it is a URL the
  // registrant chose. Provisioning would make it their avatar, and every
  // client showing it would fetch it from the registrant's server (#695, #829).
  it.each(['/sign-up/email', '/admin/create-user', '/sign-in/anonymous'])(
    'drops a picture %s was given, which no provider vouches for',
    (path) => {
      expect(providerPictureOnly({ image: PICTURE }, { path })).toEqual({ data: { image: null } });
    },
  );

  it('drops a picture given outside any endpoint', () => {
    expect(providerPictureOnly({ image: PICTURE }, null)).toEqual({ data: { image: null } });
  });

  it('changes nothing when there is no picture to drop', () => {
    expect(providerPictureOnly({ image: null }, { path: '/sign-up/email' })).toBeUndefined();
    expect(providerPictureOnly({}, { path: '/sign-up/email' })).toBeUndefined();
  });
});
