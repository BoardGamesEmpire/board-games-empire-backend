import { IgdbAuthService } from './igdb-auth.service';

describe('IgdbAuthService', () => {
  it('fetches the token from the URL it is given', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ access_token: 'stub-token' })));

    try {
      const token = await new IgdbAuthService().fetchAccessToken(
        { client_id: 'test-client-id', client_secret: 'test-secret' },
        'https://tokens.example.test/oauth2/token',
      );

      expect(token.access_token).toBe('stub-token');

      const url = new URL(String(fetchSpy.mock.calls[0][0]));
      expect(`${url.origin}${url.pathname}`).toBe('https://tokens.example.test/oauth2/token');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
