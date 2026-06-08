import type { AuthType } from '@bge/auth';

// TODO: validate this assumption
export type AnonymousUserSession = AuthType['$Infer']['Session']['user'] & { isAnonymous: boolean };
