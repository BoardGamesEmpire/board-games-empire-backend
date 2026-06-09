import type { AuthType } from '@bge/auth';

// isAnonymous exists if the anonymous plugin is loaded
export type AnonymousUserSession = AuthType['$Infer']['Session']['user'] & { isAnonymous: boolean };
