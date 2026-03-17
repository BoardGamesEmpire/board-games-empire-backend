import { authFactory } from '../auth-factory';

export type AuthType = ReturnType<typeof authFactory>;
