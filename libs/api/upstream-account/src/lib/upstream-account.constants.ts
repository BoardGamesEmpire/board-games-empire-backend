import { DataGatewayCapability, Upstream } from '@bge/database';

/** How this server links an upstream account at one upstream (#935). */
export interface LinkMethod {
  /**
   * The capability a DataGateway declaring the upstream must also serve for
   * the link to go through it, or null when the link asks the DataGateway
   * nothing.
   */
  readonly capability: DataGatewayCapability | null;
}

/**
 * The upstreams this server has a way to link an upstream account at, each
 * with its link method (#935). An upstream absent here has none. Steam's link
 * is Steam sign-in, which needs only a DataGateway declaring Steam; a
 * BoardGameGeek link looks the username up through a DataGateway (#1226). An
 * upstream is linkable while it is here and a DataGateway usable for its link
 * exists; offering one with no way to link it would offer a link every
 * attempt refuses.
 */
export const LINK_METHODS: ReadonlyMap<Upstream, LinkMethod> = new Map<Upstream, LinkMethod>([
  [Upstream.BoardGameGeek, { capability: DataGatewayCapability.FindUpstreamAccount }],
  [Upstream.Steam, { capability: null }],
]);

/**
 * The stable codes the upstream account routes' errors carry, so a client can
 * tell them apart (#935). An object of string literals rather than an enum, as
 * `PrivacyPolicyErrorCode` is: `CodedHttpException` takes an upper-case string,
 * and an enum member is not one to the compiler.
 *
 * Starting a link refuses an API key, which acts for its owner but is not
 * the owner, with `SessionRequired`: a 403 a client can tell apart from a
 * missing permission. An anonymous user holds no upstream account permission,
 * so the permission check refuses one first, with its own 403.
 *
 * A link through an upstream's sign-in ends with the browser sent back to the
 * client, so most of its refusals reach the client as the `error` of that
 * redirect rather than as an error answer: `SessionMismatch`, `Cancelled`,
 * `NotVerified` and `Failed` only ever arrive that way, and `AlreadyLinked`,
 * `Taken` and `Unreachable` can. The redirect carries the code alone, so a
 * client supplies the words for those.
 *
 * A link by username answers every refusal as an error answer, with its
 * message (#1226): `UnknownUsername` when the upstream has no user by the
 * name, `Throttled`, with the wait in `retryAfterMs`, when the DataGateway's
 * upstream budget is spent, and `Unreachable` when the lookup failed or
 * didn't answer in time.
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
  SessionRequired: 'UPSTREAM_LINK_SESSION_REQUIRED',
  Cancelled: 'UPSTREAM_LINK_CANCELLED',
  NotVerified: 'UPSTREAM_LINK_NOT_VERIFIED',
  Unreachable: 'UPSTREAM_UNREACHABLE',
  Failed: 'UPSTREAM_LINK_FAILED',
  UnknownUsername: 'UPSTREAM_ACCOUNT_UNKNOWN_USERNAME',
  Throttled: 'UPSTREAM_THROTTLED',
} as const;

export type UpstreamAccountErrorCode = (typeof UpstreamAccountErrorCode)[keyof typeof UpstreamAccountErrorCode];
