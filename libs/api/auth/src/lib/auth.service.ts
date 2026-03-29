import { Inject, Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import type { authFactory } from './auth-factory';
import { AUTH_INSTANCE } from './constants';

@Injectable()
export class AuthService {
  constructor(@Inject(AUTH_INSTANCE) private readonly auth: ReturnType<typeof authFactory>) {}

  /**
   * Retrieves the user session associated with the provided token.
   *
   * @param token The authentication token.
   * @returns The user session or null
   */
  getSessionFromToken(token: string) {
    return this.auth.api.getSession({
      headers: new Headers({
        Authorization: `Bearer ${token}`,
      }),
    });
  }

  /**
   * Validates the provided user session by checking its expiration time.
   *
   * @param session
   * @returns boolean indicating whether the session is valid or not
   */
  isValidSession(session: UserSession | null): session is UserSession {
    if (!session?.session) {
      return false;
    }

    return session.session.expiresAt > new Date();
  }
}
