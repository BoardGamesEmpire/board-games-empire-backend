export const AUTH_INSTANCE = Symbol('AUTH_INSTANCE');

export enum AuthEvent {
  UserCreated = 'auth.user.created',
}

/**
 * The base path for all BetterAuth endpoints
 */
export const AUTH_BASE_PATH = '/api/auth';
