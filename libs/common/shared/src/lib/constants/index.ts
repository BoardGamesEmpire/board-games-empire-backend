// BetterAuth does not export this, but we need it for our custom PoliciesGuard
export const IS_PUBLIC_KEY = 'PUBLIC';
export const IS_OPTIONAL_KEY = 'OPTIONAL';

export const TRACEPARENT_HEADER = 'traceparent' as const;
export const CORRELATION_ID_HEADER = 'x-correlation-id' as const;
