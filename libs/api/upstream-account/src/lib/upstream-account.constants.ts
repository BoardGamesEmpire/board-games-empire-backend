import { Upstream } from '@bge/database';

/**
 * The upstreams this server has a way to link an upstream account at (#935).
 * An upstream is linkable while it is here and an enabled DataGateway declares
 * it; offering one with no way to link it would offer a link every attempt
 * refuses.
 */
export const UPSTREAMS_WITH_LINK_METHOD: ReadonlySet<Upstream> = new Set([Upstream.Steam]);

/**
 * The stable codes the upstream account routes' errors carry, so a client can
 * tell them apart (#935). An object of string literals rather than an enum, as
 * `PrivacyPolicyErrorCode` is: `CodedHttpException` takes an upper-case string,
 * and an enum member is not one to the compiler.
 *
 * A link through an upstream's sign-in ends with the browser sent back to the
 * client, so most of its refusals reach the client as the `error` of that
 * redirect rather than as an error answer: `SessionMismatch`, `Cancelled`,
 * `NotVerified`, `Unreachable` and `Failed` only ever arrive that way, and
 * `AlreadyLinked` and `Taken` can. The redirect carries the code alone, so a
 * client supplies the words for those.
 */
export const UpstreamAccountErrorCode = {
  NotLinkable: 'UPSTREAM_NOT_LINKABLE',
  AlreadyLinked: 'UPSTREAM_ACCOUNT_ALREADY_LINKED',
  Taken: 'UPSTREAM_ACCOUNT_TAKEN',
  NotFound: 'UPSTREAM_ACCOUNT_NOT_FOUND',
  UnknownUpstream: 'UPSTREAM_UNKNOWN',
  ReturnAddressRefused: 'UPSTREAM_LINK_RETURN_ADDRESS_REFUSED',
  Expired: 'UPSTREAM_LINK_EXPIRED',
  SessionMismatch: 'UPSTREAM_LINK_SESSION_MISMATCH',
  Cancelled: 'UPSTREAM_LINK_CANCELLED',
  NotVerified: 'UPSTREAM_LINK_NOT_VERIFIED',
  Unreachable: 'UPSTREAM_UNREACHABLE',
  Failed: 'UPSTREAM_LINK_FAILED',
} as const;

export type UpstreamAccountErrorCode = (typeof UpstreamAccountErrorCode)[keyof typeof UpstreamAccountErrorCode];
