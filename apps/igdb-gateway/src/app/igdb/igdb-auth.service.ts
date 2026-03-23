import { Injectable } from '@nestjs/common';
import type { Credentials, TokenResponse } from './lib/fetch-access-token';
import { fetchAccessToken } from './lib/fetch-access-token';

/**
 * Wrapper service around the fetchAccessToken function to allow for easier testing and potential future extensions
 */
@Injectable()
export class IgdbAuthService {
  fetchAccessToken(credentials: Credentials): Promise<TokenResponse> {
    return fetchAccessToken(credentials);
  }
}
