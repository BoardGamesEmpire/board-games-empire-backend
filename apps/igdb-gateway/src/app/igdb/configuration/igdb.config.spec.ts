import Joi from 'joi';
import igdbConfig, { igdbConfigValidationSchema } from './igdb.config';

describe('igdbConfigValidationSchema — IGDB_TOKEN_URL', () => {
  const schema = Joi.object(igdbConfigValidationSchema);
  const validate = (value: string) =>
    schema.validate(
      { IGDB_CLIENT_ID: 'test-client-id', IGDB_CLIENT_SECRET: 'test-secret', IGDB_TOKEN_URL: value },
      { allowUnknown: true },
    );

  it.each([
    'https://id.twitch.tv/oauth2/token',
    'http://127.0.0.1:4010/oauth2/token',
    'http://localhost:4010/oauth2/token',
    'http://[::1]:4010/oauth2/token',
  ])('accepts %p', (value) => {
    expect(validate(value).error).toBeUndefined();
  });

  it.each(['id.twitch.tv/oauth2/token', 'ftp://id.twitch.tv/oauth2/token', ''])('rejects %p', (value) => {
    expect(validate(value).error?.message).toMatch(/IGDB_TOKEN_URL/);
  });

  // The client secret travels in the token request's query string.
  it.each(['http://id.twitch.tv/oauth2/token', 'http://token-stub:4010/oauth2/token'])(
    'rejects plain http to %p, which is not this machine',
    (value) => {
      expect(validate(value).error?.message).toMatch(/IGDB_TOKEN_URL.*https/);
    },
  );
});

describe('igdb config — token URL', () => {
  const original = process.env['IGDB_TOKEN_URL'];

  afterEach(() => {
    if (original === undefined) {
      delete process.env['IGDB_TOKEN_URL'];
    } else {
      process.env['IGDB_TOKEN_URL'] = original;
    }
  });

  it("defaults to Twitch's endpoint", () => {
    delete process.env['IGDB_TOKEN_URL'];

    expect(igdbConfig().tokenUrl).toBe('https://id.twitch.tv/oauth2/token');
  });

  it('reads IGDB_TOKEN_URL when it is set', () => {
    process.env['IGDB_TOKEN_URL'] = 'http://127.0.0.1:4010/oauth2/token';

    expect(igdbConfig().tokenUrl).toBe('http://127.0.0.1:4010/oauth2/token');
  });
});
