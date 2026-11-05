import { fetchAccessToken, type Credentials, type TokenResponse } from '@bge/gateway-driver-igdb';
import { Injectable } from '@nestjs/common';

/**
 * Wrapper service around the fetchAccessToken function to allow for easier testing and potential future extensions
 */
@Injectable()
export class IgdbAuthService {
  fetchAccessToken(credentials: Credentials, tokenUrl: string): Promise<TokenResponse> {
    return fetchAccessToken((url, request) => fetch(url, request), credentials, tokenUrl);
  }
}
