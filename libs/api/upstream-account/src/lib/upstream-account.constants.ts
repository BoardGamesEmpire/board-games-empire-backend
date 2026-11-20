import { Upstream } from '@bge/database';

/**
 * The upstreams this server has a way to link an upstream account at (#935).
 * An upstream is linkable while it is here and an enabled DataGateway declares
 * it; offering one with no way to link it would offer a link every attempt
 * refuses.
 */
export const UPSTREAMS_WITH_LINK_METHOD: ReadonlySet<Upstream> = new Set([Upstream.Steam]);

/**
 * Where a client reads the privacy policy that linking an upstream account
 * shows (#934, #935).
 */
export const PRIVACY_POLICY_PATH = '/api/privacy-policy';

/**
 * The stable codes the upstream account routes' errors carry, so a client can
 * tell them apart (#935). An object of string literals rather than an enum, as
 * `PrivacyPolicyErrorCode` is: `CodedHttpException` takes an upper-case string,
 * and an enum member is not one to the compiler.
 */
export const UpstreamAccountErrorCode = {
  NotLinkable: 'UPSTREAM_NOT_LINKABLE',
  AlreadyLinked: 'UPSTREAM_ACCOUNT_ALREADY_LINKED',
  Taken: 'UPSTREAM_ACCOUNT_TAKEN',
  NotFound: 'UPSTREAM_ACCOUNT_NOT_FOUND',
  UnknownUpstream: 'UPSTREAM_UNKNOWN',
} as const;

export type UpstreamAccountErrorCode = (typeof UpstreamAccountErrorCode)[keyof typeof UpstreamAccountErrorCode];
